import * as azdev from "azure-devops-node-api";
import { IGitApi } from "azure-devops-node-api/GitApi";
import {
  InteractiveBrowserCredential,
  AuthenticationRecord,
  serializeAuthenticationRecord,
  deserializeAuthenticationRecord,
} from "@azure/identity";
import { useIdentityPlugin } from "@azure/identity";
import { cachePersistencePlugin } from "@azure/identity-cache-persistence";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import "dotenv/config";
import { acquireForPr, release, WorktreeContext } from "./worktree-pool";

// Enable encrypted persistent token cache (DPAPI on Windows, Keychain on macOS)
try {
  useIdentityPlugin(cachePersistencePlugin);
} catch {
  // Plugin may already be registered — continue without persistence
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ORG_URL = process.env.AZURE_DEVOPS_ORG_URL!;
const PROJECT = process.env.AZURE_DEVOPS_PROJECT!;
const REPOSITORY = process.env.AZURE_DEVOPS_REPOSITORY!;
const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

// Scope state/docs per repository so multi-repo runs don't collide
const STATE_FILE = path.join(__dirname, "..", `pr-state-${REPOSITORY}.json`);
const DOCS_DIR = path.join(__dirname, "..", "pr-docs", REPOSITORY);

// ---------------------------------------------------------------------------
// Auth record persistence — cached in ~/.azuredevops-mcp/ (same as submodule)
// ---------------------------------------------------------------------------
const AUTH_RECORD_DIR = path.join(os.homedir(), ".azuredevops-mcp");

function orgUrlToLabel(): string {
  return (ORG_URL || "default")
    .replace(/^https?:\/\//, "")
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/-+$/, "");
}

function getAuthRecordPath(): string {
  return path.join(AUTH_RECORD_DIR, `auth-record-${orgUrlToLabel()}.json`);
}

function loadAuthRecord(): AuthenticationRecord | undefined {
  try {
    const filePath = getAuthRecordPath();
    if (!fs.existsSync(filePath)) return undefined;
    return deserializeAuthenticationRecord(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function saveAuthRecord(record: AuthenticationRecord): void {
  if (!fs.existsSync(AUTH_RECORD_DIR)) {
    fs.mkdirSync(AUTH_RECORD_DIR, { recursive: true });
  }
  fs.writeFileSync(getAuthRecordPath(), serializeAuthenticationRecord(record), "utf-8");
}

// ---------------------------------------------------------------------------
// Entra ID auth via InteractiveBrowserCredential with persistent cache
// ---------------------------------------------------------------------------
async function createConnection(): Promise<azdev.WebApi> {
  // Fast path: use PAT if available (no browser, no token refresh)
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (pat) {
    console.log("[Auth] Using Personal Access Token from AZURE_DEVOPS_PAT.");
    return new azdev.WebApi(ORG_URL, azdev.getPersonalAccessTokenHandler(pat));
  }

  // Entra ID flow: try silent auth first, then interactive browser
  const credentialOptions = {
    redirectUri: "http://localhost",
    tokenCachePersistenceOptions: { enabled: true },
  };

  const existingRecord = loadAuthRecord();
  if (existingRecord) {
    try {
      const probe = new InteractiveBrowserCredential({
        ...credentialOptions,
        authenticationRecord: existingRecord,
        disableAutomaticAuthentication: true,
      });
      const token = await probe.getToken(AZURE_DEVOPS_SCOPE);
      if (token) {
        console.log("[Auth] Silent authentication succeeded.");
        return new azdev.WebApi(ORG_URL, azdev.getHandlerFromToken(token.token));
      }
    } catch {
      console.log("[Auth] Cached token expired, falling back to interactive login.");
    }
  }

  console.log("[Auth] Opening browser for Entra ID login...");
  const credential = new InteractiveBrowserCredential(credentialOptions);
  const authRecord = await credential.authenticate(AZURE_DEVOPS_SCOPE);
  if (authRecord) {
    saveAuthRecord(authRecord);
    console.log("[Auth] Authentication record saved for future silent auth.");
  }

  const token = await credential.getToken(AZURE_DEVOPS_SCOPE);
  return new azdev.WebApi(ORG_URL, azdev.getHandlerFromToken(token!.token));
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
const UPDATE_COOLDOWN_MS = 15 * 60 * 1000;

interface PrStateEntry {
  lastReviewedAt: string;
  lastSourceCommitId: string;
}

interface PrState {
  lastChecked: string;
  prs: Record<string, string | PrStateEntry>;
}

/** Normalize legacy string entries (timestamp only) to the new shape. */
function parsePrEntry(entry: string | PrStateEntry): PrStateEntry {
  if (typeof entry === "string") {
    return { lastReviewedAt: entry, lastSourceCommitId: "" };
  }
  return entry;
}

function loadState(): PrState {
  if (fs.existsSync(STATE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (Array.isArray(raw.seenPrIds)) {
      const prs: Record<string, string> = {};
      for (const id of raw.seenPrIds) {
        prs[String(id)] = raw.lastChecked || new Date(0).toISOString();
      }
      return { lastChecked: raw.lastChecked, prs };
    }
    return raw;
  }
  return { lastChecked: new Date(0).toISOString(), prs: {} };
}

function saveState(state: PrState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ===========================================================================
// PR Review Document — the full context a code review tool needs
// ===========================================================================

interface PrThreadComment {
  commentId: number;
  author: string;
  content: string;
  publishedDate: string;
  parentCommentId?: number;
}

interface PrThread {
  threadId: number;
  status: string;
  filePath?: string;
  lineNumber?: number;
  iterationId?: number;           // which push/update this thread was created on
  iterationSourceCommit?: string;  // the source commit at that iteration
  comments: PrThreadComment[];
}

interface PrCommit {
  commitId: string;
  author: string;
  message: string;
  date: string;
}

interface PrIteration {
  id: number;
  createdDate: string;
  sourceCommit: string;
  targetCommit: string;
  description?: string;
}

interface PrReviewDocument {
  prId: number;
  title: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  baseCommitId: string;
  latestSourceCommitId: string;
  latestMergeCommitId: string;
  createdDate: string;
  iterations: PrIteration[];
  commits: PrCommit[];
  threads: PrThread[];
  updatedThreadsSinceLastCheck: PrThread[];
}

const THREAD_STATUS_MAP: Record<number, string> = {
  0: "unknown",
  1: "active",
  2: "fixed",
  3: "wontFix",
  4: "closed",
  5: "byDesign",
  6: "pending",
};

async function buildPrReviewDocument(
  gitApi: IGitApi,
  prId: number,
  sinceTimestamp: string | null,
  prData?: any,
): Promise<PrReviewDocument> {
  // 1. PR detail — use pre-fetched data if available, otherwise fetch
  const pr = prData ?? await gitApi.getPullRequest(REPOSITORY, prId, PROJECT);
  const title = pr.title ?? "(no title)";
  const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "unknown";
  const sourceBranch = (pr.sourceRefName ?? "").replace("refs/heads/", "");
  const targetBranch = (pr.targetRefName ?? "").replace("refs/heads/", "");
  const baseCommitId = (pr as any).lastMergeTargetCommit?.commitId ?? "";
  const latestSourceCommitId = (pr as any).lastMergeSourceCommit?.commitId ?? "";
  const latestMergeCommitId = (pr as any).lastMergeCommit?.commitId ?? "";
  const createdDate = pr.creationDate ? new Date(pr.creationDate).toISOString() : "";

  // 2. Iterations (each push/force-push to the source branch)
  const rawIterations = await gitApi.getPullRequestIterations(REPOSITORY, prId, PROJECT);
  const iterations: PrIteration[] = (rawIterations ?? []).map((it: any) => ({
    id: it.id,
    createdDate: it.createdDate ? new Date(it.createdDate).toISOString() : "",
    sourceCommit: it.sourceRefCommit?.commitId ?? "",
    targetCommit: it.targetRefCommit?.commitId ?? "",
    description: it.description,
  }));

  // 3. Commits
  const rawCommits = await gitApi.getPullRequestCommits(REPOSITORY, prId, PROJECT);
  const commits: PrCommit[] = (rawCommits ?? []).map((c: any) => ({
    commitId: c.commitId ?? "",
    author: c.author?.name ?? c.author?.email ?? "unknown",
    message: (c.comment ?? "").trim(),
    date: c.author?.date ? new Date(c.author.date).toISOString() : "",
  }));

  // 4. Comment threads — structured by thread
  // Build iteration lookup: iterationId -> source commit ID
  const iterationCommitMap = new Map<number, string>();
  for (const it of iterations) {
    iterationCommitMap.set(it.id, it.sourceCommit);
  }

  const rawThreads = await gitApi.getThreads(REPOSITORY, prId, PROJECT);
  const allThreads: PrThread[] = [];

  for (const thread of rawThreads ?? []) {
    const threadStatus = THREAD_STATUS_MAP[thread.status ?? 0] ?? "unknown";
    const filePath = thread.threadContext?.filePath ?? undefined;
    const lineNumber = thread.threadContext?.rightFileStart?.line ?? undefined;

    // The iteration context tells us which push the reviewer was looking at
    const iterationContext = (thread as any).pullRequestThreadContext?.iterationContext;
    const iterationId: number | undefined =
      iterationContext?.secondComparingIteration ?? iterationContext?.firstComparingIteration ?? undefined;
    const iterationSourceCommit = iterationId ? iterationCommitMap.get(iterationId) : undefined;

    const comments: PrThreadComment[] = [];
    for (const comment of thread.comments ?? []) {
      // Skip system-generated comments (commentType 2 = system)
      if ((comment as any).commentType === 2) continue;

      comments.push({
        commentId: comment.id!,
        author: comment.author?.displayName ?? comment.author?.uniqueName ?? "unknown",
        content: comment.content ?? "",
        publishedDate: comment.publishedDate
          ? new Date(comment.publishedDate).toISOString()
          : "",
        parentCommentId: comment.parentCommentId ?? undefined,
      });
    }

    // Skip threads with no human comments
    if (comments.length === 0) continue;

    // Sort comments within thread chronologically
    comments.sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));

    allThreads.push({
      threadId: thread.id!,
      status: threadStatus,
      filePath,
      lineNumber,
      iterationId,
      iterationSourceCommit,
      comments,
    });
  }

  // Sort threads by their earliest comment date
  allThreads.sort((a, b) =>
    (a.comments[0]?.publishedDate ?? "").localeCompare(b.comments[0]?.publishedDate ?? ""),
  );

  // 5. Filter to threads that have new comments since last check
  const updatedThreadsSinceLastCheck = sinceTimestamp
    ? allThreads
        .map((t) => ({
          ...t,
          comments: t.comments.filter((c) => c.publishedDate > sinceTimestamp),
        }))
        .filter((t) => t.comments.length > 0)
    : allThreads;

  return {
    prId,
    title,
    author,
    sourceBranch,
    targetBranch,
    baseCommitId,
    latestSourceCommitId,
    latestMergeCommitId,
    createdDate,
    iterations,
    commits,
    threads: allThreads,
    updatedThreadsSinceLastCheck,
  };
}

// ---------------------------------------------------------------------------
// Save PR review document to disk
// ---------------------------------------------------------------------------
function savePrDocument(doc: PrReviewDocument): string {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  const filePath = path.join(DOCS_DIR, `pr-${doc.prId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Full review context — PR document + worktree, saved together
// ---------------------------------------------------------------------------
interface ReviewJob {
  worktree: WorktreeContext;
  document: PrReviewDocument;
  documentPath: string;
}

function saveReviewJob(job: ReviewJob): string {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  const filePath = path.join(DOCS_DIR, `review-${job.document.prId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(job, null, 2));
  return filePath;
}

// ---------------------------------------------------------------------------
// Callback — builds review doc, acquires worktree, saves full context
// ---------------------------------------------------------------------------
type PrEvent = "new" | "updated";

/** Tracks worktrees acquired during this run so they can be released later */
const activeJobs: ReviewJob[] = [];

async function onPullRequestEvent(
  gitApi: IGitApi,
  event: PrEvent,
  prId: number,
  sinceTimestamp: string | null,
  prData?: any,
): Promise<void> {
  const tag = event === "new" ? "NEW PR" : "UPDATED PR";
  console.log(`\n[${tag}] #${prId} — building review document...`);

  // 1. Build the PR document (comments, threads, commits, iterations)
  const doc = await buildPrReviewDocument(gitApi, prId, sinceTimestamp, prData);
  const docPath = savePrDocument(doc);

  // 2. Find the last-reviewed source commit from iterations
  //    If sinceTimestamp is set, find which iteration was current at that time
  let lastReviewedCommitId: string | null = null;
  if (sinceTimestamp && doc.iterations.length > 0) {
    const previousIterations = doc.iterations.filter((it) => it.createdDate <= sinceTimestamp);
    if (previousIterations.length > 0) {
      lastReviewedCommitId = previousIterations[previousIterations.length - 1].sourceCommit;
    }
  }

  // 3. Acquire a worktree and check out the PR
  let worktreeCtx: WorktreeContext;
  try {
    worktreeCtx = acquireForPr(
      prId,
      doc.sourceBranch,
      doc.targetBranch,
      doc.title,
      doc.author,
      doc.latestSourceCommitId,
      doc.baseCommitId,
      lastReviewedCommitId,
    );
  } catch (err: any) {
    console.error(`  [WARN] Could not acquire worktree: ${err.message}`);
    console.log(`  Document saved to: ${docPath} (review without worktree)`);
    return;
  }

  // 4. Save the combined review job
  const job: ReviewJob = {
    worktree: worktreeCtx,
    document: doc,
    documentPath: docPath,
  };
  const jobPath = saveReviewJob(job);
  activeJobs.push(job);

  // 5. Summary
  const totalComments = doc.threads.reduce((n, t) => n + t.comments.length, 0);
  const newComments = doc.updatedThreadsSinceLastCheck.reduce((n, t) => n + t.comments.length, 0);

  console.log(`  --- Review Job Ready ---`);
  console.log(`  Worktree:       ${worktreeCtx.worktreePath}`);
  console.log(`  Title:          ${doc.title}`);
  console.log(`  Author:         ${doc.author}`);
  console.log(`  Branch:         ${doc.sourceBranch} -> ${doc.targetBranch}`);
  console.log(`  Base commit:    ${doc.baseCommitId.substring(0, 8)} (diff target)`);
  console.log(`  Source commit:  ${doc.latestSourceCommitId.substring(0, 8)} (checked out)`);
  if (lastReviewedCommitId) {
    console.log(`  Last reviewed:  ${lastReviewedCommitId.substring(0, 8)} (incremental from here)`);
  }
  console.log(`  Iterations:     ${doc.iterations.length}`);
  console.log(`  Commits:        ${doc.commits.length}`);
  console.log(`  Threads:        ${doc.threads.length} (${totalComments} comments)`);
  console.log(`  Updated threads:${doc.updatedThreadsSinceLastCheck.length} (${newComments} new comments)`);
  console.log(`  Full diff:      ${worktreeCtx.diffCommandFull}`);
  if (worktreeCtx.diffCommandIncremental) {
    console.log(`  Incremental:    ${worktreeCtx.diffCommandIncremental}`);
  }
  console.log(`  Job file:       ${jobPath}`);
}

// ---------------------------------------------------------------------------
// Core: fetch active non-draft PRs, detect new + updated (15 min cooldown)
// ---------------------------------------------------------------------------
async function checkForNewPRs(): Promise<void> {
  const connection = await createConnection();
  const gitApi = await connection.getGitApi();

  const searchCriteria = { status: 1 } as any;
  const pullRequests = await gitApi.getPullRequests(REPOSITORY, searchCriteria, PROJECT, undefined, 0, 200);

  const activePRs = (pullRequests ?? []).filter((pr) => !pr.isDraft);
  console.log(`Found ${activePRs.length} active non-draft PR(s).`);

  const now = Date.now();
  const state = loadState();
  let newCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const pr of activePRs) {
    const prId = pr.pullRequestId!;
    const key = String(prId);

    // Use data from the list response — no individual getPullRequest call needed
    const latestSourceCommitId: string = (pr as any).lastMergeSourceCommit?.commitId ?? "";
    const lastPushDate = new Date(
      (pr as any).lastMergeSourceCommit?.committer?.date ?? pr.creationDate ?? 0,
    );

    const previousRaw = state.prs[key];

    if (!previousRaw) {
      await onPullRequestEvent(gitApi, "new", prId, null, pr);
      state.prs[key] = { lastReviewedAt: new Date().toISOString(), lastSourceCommitId: latestSourceCommitId };
      newCount++;
    } else {
      const prev = parsePrEntry(previousRaw);
      if (latestSourceCommitId && latestSourceCommitId !== prev.lastSourceCommitId) {
        const msSincePush = now - lastPushDate.getTime();
        if (msSincePush >= UPDATE_COOLDOWN_MS) {
          await onPullRequestEvent(gitApi, "updated", prId, prev.lastReviewedAt, pr);
          state.prs[key] = { lastReviewedAt: new Date().toISOString(), lastSourceCommitId: latestSourceCommitId };
          updatedCount++;
        } else {
          const minsRemaining = Math.ceil((UPDATE_COOLDOWN_MS - msSincePush) / 60000);
          console.log(`[COOLDOWN] #${prId} — updated recently, will pick up in ~${minsRemaining} min`);
          skippedCount++;
          continue;
        }
      }
    }
  }

  // Remove PRs no longer active
  const activeIds = new Set(activePRs.map((pr) => String(pr.pullRequestId!)));
  for (const key of Object.keys(state.prs)) {
    if (!activeIds.has(key)) {
      delete state.prs[key];
    }
  }

  state.lastChecked = new Date().toISOString();
  saveState(state);

  console.log(
    `\nSummary: ${newCount} new, ${updatedCount} updated, ${skippedCount} in cooldown. ` +
    `Tracking ${Object.keys(state.prs).length} PR(s).`,
  );

  if (activeJobs.length > 0) {
    console.log(`\n=== Active Review Jobs (${activeJobs.length}) ===`);
    for (const job of activeJobs) {
      console.log(`  PR #${job.document.prId} -> ${job.worktree.worktreeId} (${job.worktree.worktreePath})`);
    }
    console.log(`\nWorktrees are held until you call: npx ts-node src/worktree-pool.ts release <id>`);
    console.log(`Or programmatically: import { release } from './worktree-pool'; release(worktreeId);`);
  }
}

// ---------------------------------------------------------------------------
// Exports for orchestrator
// ---------------------------------------------------------------------------
export {
  createConnection,
  loadState,
  saveState,
  parsePrEntry,
  buildPrReviewDocument,
  savePrDocument,
  onPullRequestEvent,
  checkForNewPRs,
  activeJobs,
  UPDATE_COOLDOWN_MS,
  REPOSITORY,
  PROJECT,
  STATE_FILE,
  DOCS_DIR,
};
export type { PrState, PrStateEntry, PrReviewDocument, PrThread, PrThreadComment, PrCommit, PrIteration, ReviewJob };

// ---------------------------------------------------------------------------
// Entry point — only runs when called directly
// ---------------------------------------------------------------------------
if (require.main === module) {
  checkForNewPRs().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
