import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type DevLifecycleState =
  | "discovered"
  | "needs_plan"
  | "plan_approved"
  | "implementing"
  | "pr_babysitting"
  | "completed"
  | "abandoned";

export interface DevWorkItemState {
  workItemId: number;
  title: string;
  state: DevLifecycleState;
  discoveredAt: string;
  updatedAt: string;

  // Approval detection
  lastWiCommentCount: number;
  lastWiCommentCheckedAt: string | null;
  approvalCommentText: string | null;
  approvalDetectedAt: string | null;

  // Plan tracking (work-on Phase 1)
  planPostedAt: string | null;
  planCommentId: number | null;

  // Worktree
  worktreePath: string;
  branchName: string | null;
  baseBranch: string | null;
  headCommitId: string | null;
  worktreeStatus: "missing" | "ready" | "dirty" | "corrupt";

  // Implementation
  implementationAttempts: number;
  lastClaudeSessionId: string | null;
  lastClaudeExitCode: number | null;
  lastFailureReason: string | null;
  lastInvokedAt: string | null;
  backoffUntil: string | null;

  // Session tracking (per phase — enables --session-id resume)
  planSessionId: string | null;
  implSessionId: string | null;
  babysitSessionId: string | null;
  babysitSessionTurnCount: number;

  // Context memory
  contextFilePath: string | null;
  lastContextWrittenAt: string | null;

  // PR tracking
  pullRequestId: number | null;
  pullRequestUrl: string | null;
  pullRequestStatus: "active" | "completed" | "abandoned" | null;

  // PR change detection (babysit gating)
  lastPrThreadCount: number;
  lastPrCommentCount: number;
  lastPrLatestActivityAt: string | null;
  lastBuildResultId: string | null;
  lastBuildStatus: string | null;
  lastTestSummaryHash: string | null;

  // Babysit scheduling
  lastBabysitCheckAt: string | null;
  lastBabysitClaudeAt: string | null;
  babysitInvocations: number;
  babysitConsecutiveFailures: number;
  babysitStartedAt: string | null;
}

export interface DevStateFile {
  version: 1;
  lastDiscoveryAt: string | null;
  items: Record<string, DevWorkItemState>;
}

// ═══════════════════════════════════════════════════════════════════
// State file path
// ═══════════════════════════════════════════════════════════════════

/** Returns the absolute path to the per-repo dev state JSON file. */
export function stateFilePath(repoName: string): string {
  return path.join(__dirname, "..", "dev-state-" + repoName + ".json");
}

// ═══════════════════════════════════════════════════════════════════
// Load / Save
// ═══════════════════════════════════════════════════════════════════

const DEFAULT_STATE: DevStateFile = { version: 1, lastDiscoveryAt: null, items: {} };

/** Loads the dev state for a repo. Returns empty default state if the file is missing or corrupt. */
export function loadDevState(repoName: string): DevStateFile {
  const p = stateFilePath(repoName);
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as DevStateFile;
    } catch (err: any) {
      console.warn(`[DevState] Corrupt state file for ${repoName}, starting fresh: ${err?.message || err}`);
    }
  }
  return { ...DEFAULT_STATE, items: {} };
}

/** Persists the dev state for a repo as pretty-printed JSON. */
export function saveDevState(repoName: string, state: DevStateFile): void {
  fs.writeFileSync(stateFilePath(repoName), JSON.stringify(state, null, 2));
}

// ═══════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════

/** Creates a new work-item state entry with sensible defaults. */
export function createDefaultWorkItemState(
  workItemId: number,
  title: string,
  worktreePath: string,
): DevWorkItemState {
  const now = new Date().toISOString();
  return {
    workItemId,
    title,
    state: "discovered",
    discoveredAt: now,
    updatedAt: now,

    lastWiCommentCount: 0,
    lastWiCommentCheckedAt: null,
    approvalCommentText: null,
    approvalDetectedAt: null,

    planPostedAt: null,
    planCommentId: null,

    worktreePath,
    branchName: null,
    baseBranch: null,
    headCommitId: null,
    worktreeStatus: "missing",

    implementationAttempts: 0,
    lastClaudeSessionId: null,
    lastClaudeExitCode: null,
    lastFailureReason: null,
    lastInvokedAt: null,
    backoffUntil: null,

    planSessionId: null,
    implSessionId: null,
    babysitSessionId: null,
    babysitSessionTurnCount: 0,

    contextFilePath: null,
    lastContextWrittenAt: null,

    pullRequestId: null,
    pullRequestUrl: null,
    pullRequestStatus: null,

    lastPrThreadCount: 0,
    lastPrCommentCount: 0,
    lastPrLatestActivityAt: null,
    lastBuildResultId: null,
    lastBuildStatus: null,
    lastTestSummaryHash: null,

    lastBabysitCheckAt: null,
    lastBabysitClaudeAt: null,
    babysitInvocations: 0,
    babysitConsecutiveFailures: 0,
    babysitStartedAt: null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// WIP helpers
// ═══════════════════════════════════════════════════════════════════

const WIP_STATES: ReadonlySet<DevLifecycleState> = new Set([
  "needs_plan",
  "plan_approved",
  "implementing",
  "pr_babysitting",
]);

/** Returns true when the lifecycle state counts toward the WIP limit. */
export function isWipState(state: DevLifecycleState): boolean {
  return WIP_STATES.has(state);
}

/** Counts items whose lifecycle state is in-progress (WIP). */
export function countWipItems(stateFile: DevStateFile): number {
  let count = 0;
  for (const key of Object.keys(stateFile.items)) {
    if (isWipState(stateFile.items[key].state)) count++;
  }
  return count;
}
