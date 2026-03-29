import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

import {
  createConnection,
  loadState,
  saveState,
  parsePrEntry,
  buildPrReviewDocument,
  savePrDocument,
  REPOSITORY,
  PROJECT,
  DOCS_DIR,
} from "./track-prs";
import type { PrReviewDocument } from "./track-prs";
import {
  initPool,
  acquireForPr,
  release,
  status as poolStatus,
  WorktreeContext,
} from "./worktree-pool";
import { formatPrIdleAge, isPrIdle, PR_IDLE_THRESHOLD_HOURS } from "./pr-idle";
import { formatPrReviewWait, getPrReviewDecision } from "./pr-review-policy";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const REPO_PATH = process.env.REPO_LOCAL_PATH!;
const POOL_SIZE = parseInt(process.env.WORKTREE_COUNT ?? "3", 10);
const CUSTOM_PROMPT_FILE = path.join(__dirname, "..", "review-prompt.md");
const RESULTS_DIR = path.join(__dirname, "..", "review-results");
const WARMUP_STAGGER_MS = parseInt(process.env.WARMUP_STAGGER_SECONDS ?? "30", 10) * 1000;

// Optional: Bluebird MCP server via Agency (auto-detected from APPDATA)
const agencyCandidate = process.env.APPDATA
  ? path.join(process.env.APPDATA, "agency", "CurrentVersion", "agency.exe")
  : null;
const agencyPath = agencyCandidate && fs.existsSync(agencyCandidate) ? agencyCandidate : null;

// ---------------------------------------------------------------------------
// Load custom prompt if present
// ---------------------------------------------------------------------------
function loadCustomPrompt(): string {
  if (!fs.existsSync(CUSTOM_PROMPT_FILE)) return "";
  const content = fs.readFileSync(CUSTOM_PROMPT_FILE, "utf-8").trim();
  // Skip if it's just the template comments
  if (!content || content.split("\n").every((l) => l.startsWith("#") || l.startsWith("<!--") || l.trim() === "")) {
    return "";
  }
  return content;
}

// ---------------------------------------------------------------------------
// Build the prompt for Claude CLI
// ---------------------------------------------------------------------------
function buildReviewPrompt(
  doc: PrReviewDocument,
  worktree: WorktreeContext,
  docPath: string,
  customPrompt: string,
): string {
  const newCommentCount = doc.updatedThreadsSinceLastCheck.reduce((n, t) => n + t.comments.length, 0);

  // Determine the diff strategy
  let diffSection: string;
  if (worktree.lastReviewedCommitId) {
    diffSection = `
## Diff Strategy

This is an **incremental review** — the PR was previously reviewed up to commit \`${worktree.lastReviewedCommitId}\`.

- **Incremental diff** (changes since last review): \`${worktree.diffCommandIncremental}\`
- **Full diff** (all PR changes vs target branch): \`${worktree.diffCommandFull}\`

Start with the incremental diff to focus on what changed. Use the full diff if you need broader context.`;
  } else {
    diffSection = `
## Diff Strategy

This is a **first review** of this PR.

- **Full diff** (all PR changes vs target branch): \`${worktree.diffCommandFull}\``;
  }

  // Build thread summary for context
  let threadSection = "";
  if (doc.updatedThreadsSinceLastCheck.length > 0) {
    threadSection = `
## Comment Threads to Address

There are **${doc.updatedThreadsSinceLastCheck.length} threads** with **${newCommentCount} new comments** since last review.
The full thread data (with file paths, line numbers, iteration context, and prior conversation) is in the review document.

Active (unresolved) threads need particular attention — check if the latest code addresses them.`;
  }

  // Custom prompt section
  const customSection = customPrompt
    ? `\n## Additional Instructions\n\n${customPrompt}`
    : "";

  return `You are reviewing PR #${doc.prId} in an Azure DevOps repository.

Use the /code-reviewer:pr-review skill to conduct this review. Load the skill first, then follow its process.

## PR Overview

- **Title:** ${doc.title}
- **Author:** ${doc.author}
- **Source branch:** ${doc.sourceBranch}
- **Target branch:** ${doc.targetBranch}
- **Iterations (pushes):** ${doc.iterations.length}
- **Commits:** ${doc.commits.length}
- **Comment threads:** ${doc.threads.length}

## Commit IDs

- **Base commit (target branch):** \`${doc.baseCommitId}\`
- **Latest source commit (PR head):** \`${doc.latestSourceCommitId}\`${worktree.lastReviewedCommitId ? `\n- **Last reviewed commit:** \`${worktree.lastReviewedCommitId}\`` : ""}

## Working Directory

The PR source branch is checked out in this working directory. You have full access to the code.
${diffSection}
${threadSection}

## Review Document

The full PR review document (iterations, commits, all threads with comments, file paths, and line numbers) is at:
\`${docPath}\`

Read this file for detailed context on every thread and comment.
${customSection}

## Your Task

1. Load the /code-reviewer:pr-review skill
2. Read the review document at the path above
3. Run the appropriate diff command(s) to understand the changes
4. Review the code changes thoroughly
5. Check if existing review comments have been addressed
6. Post your findings
`;
}

// ---------------------------------------------------------------------------
// Spawn Claude CLI in non-interactive mode
// ---------------------------------------------------------------------------
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per review

const SESSIONS_FILE = path.join(__dirname, "..", "sessions.jsonl");

interface SessionRecord {
  sessionId: string;
  prId: number;
  repo: string;
  worktreePath: string;
  startedAt: string;
  completedAt?: string;
  exitCode?: number;
  reviewResultPath?: string;
}

function saveSession(record: SessionRecord): void {
  try {
    fs.appendFileSync(SESSIONS_FILE, JSON.stringify(record) + "\n");
  } catch {
    console.warn(`[Session] Failed to write session record for PR #${record.prId}`);
  }
}

function runClaude(prompt: string, cwd: string, prId: number): Promise<{ exitCode: number; output: string; sessionId: string }> {
  const sessionId = randomUUID();
  const repo = process.env.AZURE_DEVOPS_REPOSITORY ?? "unknown";

  return new Promise((resolve) => {
    console.log(`[Claude] Spawning review for PR #${prId} in ${cwd}`);
    console.log(`[Claude] Session: ${sessionId}  CWD: ${cwd}`);

    // Save session record immediately so we can find it even if the process crashes
    saveSession({
      sessionId,
      prId,
      repo,
      worktreePath: cwd,
      startedAt: new Date().toISOString(),
    });

    // Strip CLAUDECODE env var to allow nested invocation.
    const env = { ...process.env };
    delete env.CLAUDECODE;

    // Build MCP config file so Claude can talk to Azure DevOps.
    // Write to a temp file because inline JSON gets mangled by shell: true.
    const mcpConfigPath = path.join(cwd, ".mcp-review.json");
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        "azure-devops": {
          type: "stdio",
          command: "cmd",
          args: ["/c", "npx", "-y", "@achieveai/azuredevops-mcp@1.3.15"],
          env: {
            AZURE_DEVOPS_ORG_URL: process.env.AZURE_DEVOPS_ORG_URL ?? "",
            AZURE_DEVOPS_PROJECT: process.env.AZURE_DEVOPS_PROJECT ?? "",
            AZURE_DEVOPS_REPOSITORY: process.env.AZURE_DEVOPS_REPOSITORY ?? "",
            AZURE_DEVOPS_IS_ON_PREMISES: "false",
            ...(process.env.AZURE_DEVOPS_PAT ? { AZURE_DEVOPS_PAT: process.env.AZURE_DEVOPS_PAT } : {}),
          },
        },
        ...(agencyPath ? { "bluebird": { type: "stdio", command: agencyPath, args: ["mcp", "bluebird"] } } : {}),
      },
    }, null, 2));

    // Pipe prompt via stdin to avoid Windows command-line length limits.
    // --dangerously-skip-permissions so Claude can read files, run git diff, and load skills.
    // --session-id so we can resume or inspect the conversation later.
    // --mcp-config so Claude can post comments to ADO.
    // --mcp-config is variadic, so it must come last before "--" to avoid
    // consuming the stdin flag "-" as a config path.
    const child = spawn("claude", [
      "-p", "--dangerously-skip-permissions", "--model", "opus",
      "--session-id", sessionId,
      "--mcp-config", mcpConfigPath, "--",
      "-",
    ], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
    });

    child.stdin!.write(prompt);
    child.stdin!.end();

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      console.error(`[Claude] PR #${prId} timed out after ${REVIEW_TIMEOUT_MS / 60000} min, killing.`);
      child.kill();
    }, REVIEW_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(`[PR#${prId}] ${text}`);
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(`[PR#${prId}:err] ${text}`);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

      // Save the review output
      if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
      }
      const resultPath = path.join(RESULTS_DIR, `review-${prId}-${Date.now()}.md`);
      fs.writeFileSync(resultPath, output);

      const suffix = killed ? " (timed out)" : "";
      console.log(`[Claude] PR #${prId} review complete (exit ${code})${suffix}. Saved to ${resultPath}`);
      console.log(`[Claude] Session: ${sessionId}  CWD: ${cwd}`);

      // Update session record with completion info
      saveSession({
        sessionId,
        prId,
        repo,
        worktreePath: cwd,
        startedAt: "", // already recorded on start
        completedAt: new Date().toISOString(),
        exitCode: killed ? 1 : (code ?? 1),
        reviewResultPath: resultPath,
      });

      resolve({ exitCode: killed ? 1 : (code ?? 1), output, sessionId });
    });
  });
}

// ---------------------------------------------------------------------------
// Orchestrator — the single entry point
// ---------------------------------------------------------------------------
async function orchestrate(): Promise<{ succeeded: number; failed: number; total: number }> {
  if (!REPO_PATH) {
    console.error("Set REPO_LOCAL_PATH in .env to the local clone of the target repo.");
    process.exit(1);
  }

  // 1. Initialize or verify the worktree pool
  console.log("=== Step 1: Worktree Pool ===\n");
  const pool = initPool(POOL_SIZE);
  const freeCount = pool.worktrees.filter((w) => w.status === "free").length;
  console.log(`Pool ready: ${freeCount} free worktree(s).\n`);

  if (freeCount === 0) {
    console.error("No free worktrees available. Release some or increase WORKTREE_COUNT.");
    poolStatus();
    process.exit(1);
  }

  // 2. Connect and find PRs that need review
  console.log("=== Step 2: Detecting PRs ===\n");
  const connection = await createConnection();
  const gitApi = await connection.getGitApi();

  const searchCriteria = { status: 1 } as any;
  const pullRequests = await gitApi.getPullRequests(REPOSITORY, searchCriteria, PROJECT, undefined, 0, 200);
  const activePRs = (pullRequests ?? []).filter((pr) => !pr.isDraft);
  console.log(`Found ${activePRs.length} active non-draft PR(s).`);

  const now = Date.now();
  const state = loadState();
  let idleCount = 0;

  // Collect PRs that need review after timing gates clear
  const prsToReview: {
    prId: number;
    sinceTimestamp: string | null;
    sourceCommitId: string;
    prData?: any;
  }[] = [];

  for (const pr of activePRs) {
    const prId = pr.pullRequestId!;
    const key = String(prId);

    if (isPrIdle(pr, now)) {
      idleCount++;
      console.log(
        `  [IDLE] PR #${prId} — no source activity for ${formatPrIdleAge(pr, now)}; ` +
        `skipping PRs idle over ${PR_IDLE_THRESHOLD_HOURS}h`,
      );
      continue;
    }

    const previousRaw = state.prs[key];

    const previous = previousRaw ? parsePrEntry(previousRaw) : null;
    const decision = getPrReviewDecision(pr, previous, now);

    if (decision.kind === "wait") {
      console.log(`  [DEFER] PR #${prId} — ${formatPrReviewWait(decision)}`);
      continue;
    }

    if (decision.kind === "ignore") {
      continue;
    }

    prsToReview.push({
      prId,
      sinceTimestamp: decision.sinceTimestamp,
      sourceCommitId: decision.latestSourceCommitId,
      prData: pr,
    });

    if (prsToReview.length >= freeCount) break; // Don't exceed available worktrees
  }

  if (prsToReview.length === 0) {
    console.log(`\nNo PRs need review right now.${idleCount > 0 ? ` Skipped ${idleCount} idle PR(s).` : ""}`);
    return { succeeded: 0, failed: 0, total: 0 };
  }

  console.log(
    `\n${prsToReview.length} PR(s) to review (limited to ${freeCount} free worktrees).` +
    `${idleCount > 0 ? ` Skipped ${idleCount} idle PR(s).` : ""}\n`,
  );

  // 3. Load custom prompt
  const customPrompt = loadCustomPrompt();
  if (customPrompt) {
    console.log("Custom review prompt loaded from review-prompt.md\n");
  }

  // 4. Build documents, acquire worktrees, spawn Claude
  console.log("=== Step 3: Launching Reviews ===\n");

  const jobs: {
    prId: number;
    worktreeId: string;
    docPath: string;
    promise: Promise<{ exitCode: number; output: string }>;
    sourceCommitId: string;
  }[] = [];

  for (const pr of prsToReview) {
    let acquiredWorktreeId: string | null = null;
    try {
      // Build PR document
      console.log(`--- PR #${pr.prId} ---`);
      const doc = await buildPrReviewDocument(gitApi, pr.prId, pr.sinceTimestamp, pr.prData);
      const docPath = savePrDocument(doc);

      // Find last-reviewed commit from iterations
      let lastReviewedCommitId: string | null = null;
      if (pr.sinceTimestamp && doc.iterations.length > 0) {
        const prev = doc.iterations.filter((it) => it.createdDate <= pr.sinceTimestamp!);
        if (prev.length > 0) {
          lastReviewedCommitId = prev[prev.length - 1].sourceCommit;
        }
      }

      // Acquire worktree
      const worktree = acquireForPr(
        pr.prId,
        doc.sourceBranch,
        doc.targetBranch,
        doc.title,
        doc.author,
        doc.latestSourceCommitId,
        doc.baseCommitId,
        lastReviewedCommitId,
      );
      acquiredWorktreeId = worktree.worktreeId;

      // Build prompt and spawn Claude
      const prompt = buildReviewPrompt(doc, worktree, docPath, customPrompt);

      // Save the prompt for debugging
      if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const promptPath = path.join(RESULTS_DIR, `prompt-${pr.prId}.md`);
      fs.writeFileSync(promptPath, prompt);

      // Stagger Claude spawns so we don't launch all reviews simultaneously
      if (jobs.length > 0 && WARMUP_STAGGER_MS > 0) {
        console.log(`  [WARMUP] Waiting ${WARMUP_STAGGER_MS / 1000}s before starting next review...`);
        await new Promise((r) => setTimeout(r, WARMUP_STAGGER_MS));
      }

      // Spawn Claude CLI — runs in the worktree directory
      const promise = runClaude(prompt, worktree.worktreePath, pr.prId);

      jobs.push({
        prId: pr.prId,
        worktreeId: worktree.worktreeId,
        docPath,
        promise,
        sourceCommitId: pr.sourceCommitId,
      });
    } catch (err: any) {
      console.error(`  [ERROR] PR #${pr.prId}: ${err.message}`);
      // Release worktree if acquired but job setup failed
      if (acquiredWorktreeId) {
        try { release(acquiredWorktreeId); } catch { /* best effort */ }
      }
    }
  }

  if (jobs.length === 0) {
    console.log("No reviews were launched.");
    return { succeeded: 0, failed: 0, total: 0 };
  }

  // 5. Wait for all Claude processes to complete
  console.log(`\n=== Waiting for ${jobs.length} review(s) to complete ===\n`);

  const results = await Promise.allSettled(jobs.map((j) => j.promise));

  // 6. Release worktrees and update state
  console.log("\n=== Step 4: Cleanup ===\n");

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const result = results[i];
    const exitCode = result.status === "fulfilled" ? result.value.exitCode : -1;

    // Release the worktree
    try {
      release(job.worktreeId);
    } catch (err: any) {
      console.error(`  [WARN] Could not release ${job.worktreeId}: ${err.message}`);
    }

    // Only mark PR as reviewed if Claude exited cleanly AND produced
    // meaningful output. This prevents marking a PR as "done" when the
    // review was truncated, timed out, or failed to post comments.
    const output = result.status === "fulfilled" ? result.value.output : "";
    const MIN_REVIEW_LENGTH = 200; // A real review is at least a few hundred chars
    const hasSubstance = output.length >= MIN_REVIEW_LENGTH;

    if (exitCode === 0 && hasSubstance) {
      state.prs[String(job.prId)] = {
        lastReviewedAt: new Date().toISOString(),
        lastSourceCommitId: job.sourceCommitId,
      };
      console.log(`  [OK] PR #${job.prId} — review verified (${output.length} chars), state updated.`);
    } else {
      const reason = exitCode !== 0
        ? `exit code ${exitCode}`
        : `output too short (${output.length} chars — review likely incomplete)`;
      console.log(`  [SKIP] PR #${job.prId} — ${reason}, NOT updating state. Will retry next cycle.`);
    }
  }

  // Clean up PRs no longer active
  const activeIds = new Set(activePRs.map((pr) => String(pr.pullRequestId!)));
  for (const key of Object.keys(state.prs)) {
    if (!activeIds.has(key)) delete state.prs[key];
  }

  state.lastChecked = new Date().toISOString();
  saveState(state);

  // 7. Summary
  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value.exitCode === 0).length;
  const failed = jobs.length - succeeded;

  console.log(`\n=== Done ===`);
  console.log(`  Reviews: ${succeeded} succeeded, ${failed} failed`);
  console.log(`  State saved. Tracking ${Object.keys(state.prs).length} PR(s).`);
  poolStatus();

  return { succeeded, failed, total: jobs.length };
}

export { orchestrate, buildReviewPrompt, runClaude, loadCustomPrompt, REVIEW_TIMEOUT_MS };

// ---------------------------------------------------------------------------
// CLI — only runs when called directly
// ---------------------------------------------------------------------------
if (require.main === module) {
  orchestrate().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
