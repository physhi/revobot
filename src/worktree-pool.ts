/// <reference types="node" />
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REPO_PATH = process.env.REPO_LOCAL_PATH!;
const POOL_SIZE = parseInt(process.env.WORKTREE_COUNT ?? "3", 10);
const POOL_DIR = path.join(REPO_PATH, ".worktree-pool");
const POOL_STATE_FILE = path.join(POOL_DIR, "pool-state.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Worktree {
  id: string;
  path: string;
  status: "free" | "in-use";
  assignedPrId?: number;
  assignedAt?: string;
}

interface PoolState {
  repoPath: string;
  createdAt: string;
  worktrees: Worktree[];
}

/** Everything a review agent needs to start working */
export interface WorktreeContext {
  worktreeId: string;
  worktreePath: string;
  prId: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  /** The commit on the target branch that the PR is based on — full review diffs against this */
  baseCommitId: string;
  /** The head of the PR source branch right now */
  latestSourceCommitId: string;
  /** The source commit we last reviewed (from pr-state.json). Null on first review.
   *  Incremental review diffs between this and latestSourceCommitId. */
  lastReviewedCommitId: string | null;
  /** Ready-to-run: full diff against target branch */
  diffCommandFull: string;
  /** Ready-to-run: incremental diff since last review (only if lastReviewedCommitId is set) */
  diffCommandIncremental: string | null;
}

// ---------------------------------------------------------------------------
// Git helpers — all run against the main repo
// ---------------------------------------------------------------------------
function git(args: string, cwd: string = REPO_PATH): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gitSafe(args: string, cwd: string = REPO_PATH): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pool state persistence
// ---------------------------------------------------------------------------
function loadPool(): PoolState | null {
  if (!fs.existsSync(POOL_STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(POOL_STATE_FILE, "utf-8"));
  } catch {
    console.warn("[Pool] Corrupted pool-state.json, re-initializing.");
    return null;
  }
}

function savePool(state: PoolState): void {
  fs.writeFileSync(POOL_STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// init — create the worktree pool
// ---------------------------------------------------------------------------
export function initPool(count: number = POOL_SIZE): PoolState {
  if (!fs.existsSync(REPO_PATH)) {
    throw new Error(`Repo not found at ${REPO_PATH}. Set REPO_LOCAL_PATH in .env`);
  }

  // Fetch latest from origin
  console.log(`[Pool] Fetching latest from origin in ${REPO_PATH}...`);
  git("fetch origin");

  if (!fs.existsSync(POOL_DIR)) {
    fs.mkdirSync(POOL_DIR, { recursive: true });
  }

  const existing = loadPool();
  const worktrees: Worktree[] = existing?.worktrees ?? [];

  // Auto-release stale worktrees (stuck from killed processes)
  const STALE_THRESHOLD_MS = 45 * 60 * 1000; // 45 minutes
  for (const wt of worktrees) {
    if (wt.status === "in-use" && wt.assignedAt) {
      const age = Date.now() - new Date(wt.assignedAt).getTime();
      if (age > STALE_THRESHOLD_MS) {
        console.log(`[Pool] Auto-releasing stale worktree ${wt.id} (PR #${wt.assignedPrId}, stuck for ${Math.round(age / 60000)} min)`);
        gitSafe("clean -fd", wt.path);
        gitSafe("checkout --detach HEAD", wt.path);
        wt.status = "free";
        delete wt.assignedPrId;
        delete wt.assignedAt;
      }
    }
  }

  // Find the default branch
  const defaultBranch = git("symbolic-ref refs/remotes/origin/HEAD").replace("refs/remotes/origin/", "");

  for (let i = worktrees.length; i < count; i++) {
    const id = `review-${i}`;
    const wtPath = path.join(POOL_DIR, id);

    if (fs.existsSync(wtPath)) {
      console.log(`[Pool] Worktree ${id} already exists at ${wtPath}, reusing.`);
    } else {
      console.log(`[Pool] Creating worktree ${id}...`);
      git(`worktree add --detach "${wtPath}"`);
      // Start on the default branch head
      git(`checkout origin/${defaultBranch} --detach`, wtPath);
    }

    worktrees.push({ id, path: wtPath, status: "free" });
  }

  const state: PoolState = {
    repoPath: REPO_PATH,
    createdAt: new Date().toISOString(),
    worktrees,
  };

  savePool(state);
  console.log(`[Pool] Initialized ${worktrees.length} worktree(s) in ${POOL_DIR}`);
  return state;
}

// ---------------------------------------------------------------------------
// acquire — lock a worktree and set it up for a PR
// ---------------------------------------------------------------------------
export function acquireForPr(
  prId: number,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  author: string,
  latestSourceCommitId: string,
  baseCommitId: string,
  lastReviewedCommitId: string | null,
): WorktreeContext {
  const pool = loadPool();
  if (!pool) throw new Error("Pool not initialized. Run: npx ts-node src/worktree-pool.ts init");

  const worktree = pool.worktrees.find((w) => w.status === "free");
  if (!worktree) {
    throw new Error(
      `No free worktrees. All ${pool.worktrees.length} are in use. ` +
      `Increase WORKTREE_COUNT or release a worktree.`
    );
  }

  console.log(`[Pool] Acquiring worktree ${worktree.id} for PR #${prId}...`);

  // Only fetch if the commit isn't already available locally
  // (initPool does a full fetch at startup, so most commits are already here)
  const hasLocally = gitSafe(`cat-file -t ${latestSourceCommitId}`) === "commit";
  if (hasLocally) {
    console.log(`[Pool] Commit ${latestSourceCommitId.substring(0, 8)} already local — skipping fetch`);
  } else {
    const sourceRef = `refs/heads/${sourceBranch}`;
    console.log(`[Pool] Fetching ${sourceRef}...`);
    git(`fetch origin ${sourceRef}`);
    const targetRef = `refs/heads/${targetBranch}`;
    gitSafe(`fetch origin ${targetRef}`);
  }

  // Clean the worktree and check out the PR's latest source commit
  console.log(`[Pool] Checking out ${latestSourceCommitId.substring(0, 8)} in ${worktree.id}...`);
  git("clean -fd", worktree.path);
  git(`checkout --detach ${latestSourceCommitId}`, worktree.path);
  git("clean -fd", worktree.path);

  // Mark as in-use
  worktree.status = "in-use";
  worktree.assignedPrId = prId;
  worktree.assignedAt = new Date().toISOString();
  savePool(pool);

  // Build diff commands
  const diffCommandFull = `git diff ${baseCommitId}...${latestSourceCommitId}`;
  const diffCommandIncremental = lastReviewedCommitId
    ? `git diff ${lastReviewedCommitId}...${latestSourceCommitId}`
    : null;

  const context: WorktreeContext = {
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    prId,
    title,
    author,
    sourceBranch,
    targetBranch,
    baseCommitId,
    latestSourceCommitId,
    lastReviewedCommitId,
    diffCommandFull,
    diffCommandIncremental,
  };

  console.log(`[Pool] Worktree ready:`);
  console.log(`  ID:             ${context.worktreeId}`);
  console.log(`  Path:           ${context.worktreePath}`);
  console.log(`  PR:             #${prId} — ${title}`);
  console.log(`  Branch:         ${sourceBranch} -> ${targetBranch}`);
  console.log(`  Base commit:    ${baseCommitId.substring(0, 8)} (target branch)`);
  console.log(`  Source commit:  ${latestSourceCommitId.substring(0, 8)} (PR head)`);
  if (lastReviewedCommitId) {
    console.log(`  Last reviewed:  ${lastReviewedCommitId.substring(0, 8)} (incremental from here)`);
  } else {
    console.log(`  Last reviewed:  (none — first review, use full diff)`);
  }
  console.log(`  Full diff:      ${diffCommandFull}`);
  if (diffCommandIncremental) {
    console.log(`  Incremental:    ${diffCommandIncremental}`);
  }

  return context;
}

// ---------------------------------------------------------------------------
// release — clean up and return a worktree to the pool
// ---------------------------------------------------------------------------
export function release(worktreeId: string): void {
  const pool = loadPool();
  if (!pool) throw new Error("Pool not initialized.");

  const worktree = pool.worktrees.find((w) => w.id === worktreeId);
  if (!worktree) throw new Error(`Worktree ${worktreeId} not found in pool.`);

  console.log(`[Pool] Releasing worktree ${worktreeId} (was PR #${worktree.assignedPrId})...`);

  // Preserve .scratchpad before cleaning — copy it to review-results/
  const scratchpadSrc = path.join(worktree.path, ".scratchpad");
  if (fs.existsSync(scratchpadSrc)) {
    const resultsDir = path.join(__dirname, "..", "review-results");
    const scratchpadDest = path.join(resultsDir, "scratchpad", String(worktree.assignedPrId));
    if (!fs.existsSync(scratchpadDest)) {
      fs.mkdirSync(scratchpadDest, { recursive: true });
    }
    fs.cpSync(scratchpadSrc, scratchpadDest, { recursive: true });
    console.log(`[Pool] Preserved .scratchpad to ${scratchpadDest}`);
  }

  // Reset to a clean detached state
  git("clean -fd", worktree.path);
  git("checkout --detach HEAD", worktree.path);
  git("clean -fd", worktree.path);

  worktree.status = "free";
  delete worktree.assignedPrId;
  delete worktree.assignedAt;
  savePool(pool);

  console.log(`[Pool] Worktree ${worktreeId} returned to pool.`);
}

// ---------------------------------------------------------------------------
// status — show current pool state
// ---------------------------------------------------------------------------
export function status(): void {
  const pool = loadPool();
  if (!pool) {
    console.log("Pool not initialized. Run: npx ts-node src/worktree-pool.ts init");
    return;
  }

  const free = pool.worktrees.filter((w) => w.status === "free").length;
  const inUse = pool.worktrees.filter((w) => w.status === "in-use").length;

  console.log(`Worktree Pool (${pool.repoPath})`);
  console.log(`  Total: ${pool.worktrees.length}  |  Free: ${free}  |  In use: ${inUse}\n`);

  for (const wt of pool.worktrees) {
    if (wt.status === "free") {
      console.log(`  [FREE]   ${wt.id}  ${wt.path}`);
    } else {
      console.log(`  [IN-USE] ${wt.id}  PR #${wt.assignedPrId}  since ${wt.assignedAt}  ${wt.path}`);
    }
  }
}

// ---------------------------------------------------------------------------
// destroy — remove all worktrees and clean up
// ---------------------------------------------------------------------------
export function destroyPool(): void {
  const pool = loadPool();
  if (!pool) {
    console.log("No pool to destroy.");
    return;
  }

  for (const wt of pool.worktrees) {
    console.log(`[Pool] Removing worktree ${wt.id}...`);
    gitSafe(`worktree remove --force "${wt.path}"`);
  }

  if (fs.existsSync(POOL_DIR)) {
    fs.rmSync(POOL_DIR, { recursive: true, force: true });
  }

  git("worktree prune");
  console.log("[Pool] All worktrees destroyed and pruned.");
}

// ---------------------------------------------------------------------------
// CLI entry point
//   npx ts-node src/worktree-pool.ts init [count]
//   npx ts-node src/worktree-pool.ts status
//   npx ts-node src/worktree-pool.ts release <worktree-id>
//   npx ts-node src/worktree-pool.ts destroy
// ---------------------------------------------------------------------------
function main(): void {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "init":
      initPool(args[0] ? parseInt(args[0], 10) : POOL_SIZE);
      break;
    case "status":
      status();
      break;
    case "release":
      if (!args[0]) { console.error("Usage: release <worktree-id>"); process.exit(1); }
      release(args[0]);
      break;
    case "destroy":
      destroyPool();
      break;
    default:
      console.error("Usage: npx ts-node src/worktree-pool.ts <init|status|release|destroy>");
      process.exit(1);
  }
}

if (require.main === module) {
  main();
}
