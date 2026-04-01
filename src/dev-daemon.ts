import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import * as azdev from "azure-devops-node-api";
import { BearerCredentialHandler } from "azure-devops-node-api/handlers/bearertoken";
import { IGitApi } from "azure-devops-node-api/GitApi";
import { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi";
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
import {
  DevStateFile, DevWorkItemState, DevLifecycleState,
  loadDevState, saveDevState, createDefaultWorkItemState, isWipState, countWipItems,
} from "./dev-state";
import {
  buildPlanPrompt, buildImplementationPrompt, buildBabysitPrompt,
  buildSummarizePrompt, buildKnowledgeExtractionPrompt,
  parseResultBlock, extractPrIdFallback,
} from "./dev-prompts";

// ═══════════════════════════════════════════════════════════════════
// Identity cache persistence
// ═══════════════════════════════════════════════════════════════════

try { useIdentityPlugin(cachePersistencePlugin); } catch { /* Already registered */ }

// ═══════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════

const REPOS_CONFIG = path.join(__dirname, "..", "repos.json");
const ACTIVITY_LOG = path.join(__dirname, "..", "activity.jsonl");
const SESSIONS_FILE = path.join(__dirname, "..", "sessions.jsonl");
const RESULTS_DIR = path.join(__dirname, "..", "review-results");
const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

// Dev daemon specific
const MAX_WIP_ITEMS = parseInt(process.env.MAX_WIP_ITEMS ?? "2", 10);
const BABYSIT_INTERVAL_MS = parseInt(process.env.BABYSIT_INTERVAL_MINUTES ?? "15", 10) * 60 * 1000;
const BABYSIT_TIMEOUT_MS = parseInt(process.env.BABYSIT_TIMEOUT_HOURS ?? "72", 10) * 60 * 60 * 1000;
const BABYSIT_MAX_INVOCATIONS = parseInt(process.env.BABYSIT_MAX_INVOCATIONS ?? "20", 10);
const IMPLEMENTATION_MAX_ATTEMPTS = parseInt(process.env.IMPLEMENTATION_MAX_ATTEMPTS ?? "3", 10);
const DEVELOPER_UPN = process.env.DEVELOPER_UPN ?? "";
const DEV_WORKTREE_BASE = process.env.DEV_WORKTREE_BASE ?? "";
const POLL_INTERVAL_MS = parseInt(process.env.DEV_POLL_INTERVAL_MINUTES ?? "10", 10) * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const SUMMARIZE_TIMEOUT_MS = 5 * 60 * 1000;
const BABYSIT_SESSION_RESET_TURNS = 5;
const KNOWLEDGE_FILE = path.resolve("scratchpad", "architecture-knowledge.md");

// Approval keywords
const DEFAULT_APPROVAL_KEYWORDS = "approved,go ahead,let's,proceed,implement,rock,lgtm,ship it,do it,yes,confirmed";
const APPROVAL_KEYWORDS = (process.env.APPROVAL_KEYWORDS ?? DEFAULT_APPROVAL_KEYWORDS)
  .split(",").map(k => k.trim().toLowerCase()).filter(Boolean);

// ═══════════════════════════════════════════════════════════════════
// Repository configuration
// ═══════════════════════════════════════════════════════════════════

interface RepoConfig {
  name: string;
  orgUrl: string;
  project: string;
  repository: string;
  localPath: string;
  worktreeCount: number;
  enabled: boolean;
}

// ═══════════════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════════════

interface ActivityEntry {
  timestamp: string;
  repo: string;
  event: string;
  workItemId?: number;
  prId?: number;
  details?: string;
  duration?: number;
}

function logActivity(entry: ActivityEntry): void {
  try { fs.appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + "\n"); } catch { /* best effort */ }
}

function log(tag: string, msg: string): void {
  console.log(`[${tag}] ${msg}`);
}

function logErr(tag: string, msg: string): void {
  console.error(`[${tag}] ${msg}`);
}

function saveSession(record: any): void {
  try { fs.appendFileSync(SESSIONS_FILE, JSON.stringify(record) + "\n"); } catch { /* best effort */ }
}

// ═══════════════════════════════════════════════════════════════════
// Entra ID auth
// ═══════════════════════════════════════════════════════════════════

// Entra ID access tokens expire after ~1h. The daemon runs indefinitely, so
// the static token baked into BearerCredentialHandler goes stale.  This
// subclass intercepts 401 responses, silently refreshes the token via the
// cached InteractiveBrowserCredential, and retries the request.
class AutoRefreshBearerHandler extends BearerCredentialHandler {
  private credential: InteractiveBrowserCredential;
  private scope: string;

  constructor(initialToken: string, credential: InteractiveBrowserCredential, scope: string) {
    super(initialToken);
    this.credential = credential;
    this.scope = scope;
  }

  canHandleAuthentication(response: { message?: { statusCode?: number } }): boolean {
    return response?.message?.statusCode === 401;
  }

  async handleAuthentication(httpClient: any, requestInfo: any, data: any): Promise<any> {
    const fresh = await this.credential.getToken(this.scope);
    if (fresh) {
      this.token = fresh.token;
      console.log("[Auth] Token refreshed silently after 401.");
    }
    requestInfo.options.headers["Authorization"] = `Bearer ${this.token}`;
    return httpClient.requestRaw(requestInfo, data);
  }
}

const AUTH_RECORD_DIR = path.join(os.homedir(), ".azuredevops-mcp");

function orgUrlToLabel(orgUrl: string): string {
  return (orgUrl || "default").replace(/^https?:\/\//, "").replace(/[/\\:*?"<>|]+/g, "-").replace(/-+$/, "");
}

function loadAuthRecord(orgUrl: string): AuthenticationRecord | undefined {
  try {
    const filePath = path.join(AUTH_RECORD_DIR, `auth-record-${orgUrlToLabel(orgUrl)}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    return deserializeAuthenticationRecord(fs.readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    console.warn(`[Auth] Failed to load auth record for ${orgUrlToLabel(orgUrl)}: ${err?.message || err}`);
    return undefined;
  }
}

function saveAuthRecord(orgUrl: string, record: AuthenticationRecord): void {
  if (!fs.existsSync(AUTH_RECORD_DIR)) fs.mkdirSync(AUTH_RECORD_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(AUTH_RECORD_DIR, `auth-record-${orgUrlToLabel(orgUrl)}.json`),
    serializeAuthenticationRecord(record), "utf-8",
  );
}

async function createConnection(orgUrl: string): Promise<azdev.WebApi> {
  // Fast path: use PAT if available (no browser, no token refresh)
  const pat = process.env.AZURE_DEVOPS_PAT;
  if (pat) {
    console.log("[Auth] Using Personal Access Token from AZURE_DEVOPS_PAT.");
    return new azdev.WebApi(orgUrl, azdev.getPersonalAccessTokenHandler(pat));
  }

  // Entra ID flow: try silent auth first, then interactive browser.
  // The credential is kept alive so AutoRefreshBearerHandler can silently
  // refresh the token on 401 without opening a browser.
  const credentialOptions = {
    redirectUri: "http://localhost",
    tokenCachePersistenceOptions: { enabled: true },
  };

  const existingRecord = loadAuthRecord(orgUrl);
  if (existingRecord) {
    try {
      const credential = new InteractiveBrowserCredential({
        ...credentialOptions,
        authenticationRecord: existingRecord,
        disableAutomaticAuthentication: true,
      });
      const token = await credential.getToken(AZURE_DEVOPS_SCOPE);
      if (token) {
        console.log("[Auth] Silent authentication succeeded (auto-refresh enabled).");
        const handler = new AutoRefreshBearerHandler(token.token, credential, AZURE_DEVOPS_SCOPE);
        return new azdev.WebApi(orgUrl, handler);
      }
    } catch {
      console.log("[Auth] Cached token expired, falling back to interactive login.");
    }
  }

  console.log("[Auth] Opening browser for Entra ID login...");
  const credential = new InteractiveBrowserCredential(credentialOptions);
  const authRecord = await credential.authenticate(AZURE_DEVOPS_SCOPE);
  if (authRecord) {
    saveAuthRecord(orgUrl, authRecord);
    console.log("[Auth] Authentication record saved.");
  }
  const token = await credential.getToken(AZURE_DEVOPS_SCOPE);

  // For ongoing refresh, create a silent-only credential with the auth record
  const silentCredential = new InteractiveBrowserCredential({
    ...credentialOptions,
    authenticationRecord: authRecord ?? existingRecord,
    disableAutomaticAuthentication: true,
  });
  const handler = new AutoRefreshBearerHandler(token!.token, silentCredential, AZURE_DEVOPS_SCOPE);
  return new azdev.WebApi(orgUrl, handler);
}

// ═══════════════════════════════════════════════════════════════════
// Git helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Executes a git command and returns trimmed stdout.
 */
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/**
 * Executes a git command and returns null on failure.
 */
function gitSafe(args: string, cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

/**
 * Detects the default remote branch for a repository.
 */
function findDefaultBranch(repoPath: string): string {
  for (const candidate of ["dev", "master", "main"]) {
    if (gitSafe(`rev-parse --verify origin/${candidate}`, repoPath)) return candidate;
  }
  return git("symbolic-ref refs/remotes/origin/HEAD", repoPath).replace("refs/remotes/origin/", "");
}

// ═══════════════════════════════════════════════════════════════════
// Per-work-item worktree management
// ═══════════════════════════════════════════════════════════════════

interface WorktreeResult {
  worktreePath: string;
  baseBranch: string;
  worktreeStatus: "missing" | "ready" | "dirty" | "corrupt";
}

/**
 * Ensures a stable per-work-item worktree exists for the developer daemon.
 */
function ensureWorkItemWorktree(repoPath: string, workItemId: number, repoName: string): WorktreeResult {
  const wtPath = path.join(DEV_WORKTREE_BASE, repoName, `wi-${workItemId}`);

  // Fetch latest
  gitSafe("fetch origin", repoPath);
  const baseBranch = findDefaultBranch(repoPath);

  if (!fs.existsSync(wtPath)) {
    // Create new worktree
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    git(`worktree add --detach "${wtPath}"`, repoPath);
    git(`checkout origin/${baseBranch} --detach`, wtPath);
    return { worktreePath: wtPath, baseBranch, worktreeStatus: "ready" };
  }

  // Exists — check health
  const status = gitSafe("status --porcelain", wtPath);
  if (status === null) {
    // Corrupt — remove and recreate
    log("Worktree", `wi-${workItemId} corrupt, recreating`);
    try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoPath, encoding: "utf-8" }); } catch { /* may fail */ }
    try { fs.rmSync(wtPath, { recursive: true, force: true }); } catch { /* best effort */ }
    git(`worktree add --detach "${wtPath}"`, repoPath);
    git(`checkout origin/${baseBranch} --detach`, wtPath);
    return { worktreePath: wtPath, baseBranch, worktreeStatus: "ready" };
  }

  if (status.trim() !== "") {
    // Dirty — check if it has a branch (implementation in progress) vs stale
    // If there's a branch checked out, leave it (implementation may be in progress)
    const branch = gitSafe("rev-parse --abbrev-ref HEAD", wtPath);
    if (branch && branch !== "HEAD") {
      // Has a feature branch — leave as-is, it's an in-progress implementation
      return { worktreePath: wtPath, baseBranch, worktreeStatus: "dirty" };
    }
    // Detached + dirty = stale, clean up
    gitSafe("clean -fd", wtPath);
    gitSafe("checkout --detach HEAD", wtPath);
    return { worktreePath: wtPath, baseBranch, worktreeStatus: "ready" };
  }

  // Clean
  return { worktreePath: wtPath, baseBranch, worktreeStatus: "ready" };
}

/**
 * Removes a per-work-item worktree and its transient MCP config.
 */
function cleanupWorkItemWorktree(worktreePath: string, repoPath: string): void {
  try {
    // Clean up MCP config
    try { fs.unlinkSync(path.join(worktreePath, ".mcp-review.json")); } catch { /* may not exist */ }
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, encoding: "utf-8" });
    log("Worktree", `Removed worktree: ${worktreePath}`);
  } catch (err: any) {
    logErr("Worktree", `Failed to remove worktree ${worktreePath}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Smart change detection
// ═══════════════════════════════════════════════════════════════════

interface ApprovalScanResult {
  changed: boolean;
  approved: boolean;
  newCommentCount: number;
  approvalSnippet: string | null;
}

// Negation words that precede approval keywords and invert their meaning
const NEGATION_PATTERN = /\b(?:no|not|don't|dont|do\s+not|never|neither|cannot|can't|shouldn't|won't|wouldn't)\b/i;

/**
 * Tests whether `plainText` contains an approval keyword as a whole word,
 * not preceded by a negation within the same sentence.
 */
export function matchesApprovalKeyword(plainText: string): string | null {
  for (const keyword of APPROVAL_KEYWORDS) {
    const keywordRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const match = keywordRegex.exec(plainText);
    if (match) {
      // Check for negation in the 40 characters preceding the match
      const prefixStart = Math.max(0, match.index - 40);
      const prefix = plainText.slice(prefixStart, match.index);
      if (NEGATION_PATTERN.test(prefix)) continue;
      return keyword;
    }
  }
  return null;
}

/**
 * Scans newly added work item comments for approval signals.
 */
async function scanWiApproval(
  witApi: IWorkItemTrackingApi,
  project: string,
  workItemId: number,
  lastCommentCount: number,
): Promise<ApprovalScanResult> {
  // Get comments page — WorkItemTrackingApi.getComments returns { totalCount, comments[] }
  const commentsResult = await witApi.getComments(project, workItemId);
  const totalCount = commentsResult?.totalCount ?? 0;

  if (totalCount === lastCommentCount) {
    return { changed: false, approved: false, newCommentCount: totalCount, approvalSnippet: null };
  }

  // New comments — scan them for approval keywords
  const comments = commentsResult?.comments ?? [];
  // Only check comments we haven't seen — take from the END (newest) since API returns ascending order
  const delta = Math.min(totalCount - lastCommentCount, comments.length);
  const newComments = comments.slice(-delta);

  for (const comment of newComments) {
    const text = (comment.text ?? "").toLowerCase();
    // Strip HTML tags for keyword matching
    const plainText = text.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ");
    const matchedKeyword = matchesApprovalKeyword(plainText);
    if (matchedKeyword) {
      return {
        changed: true,
        approved: true,
        newCommentCount: totalCount,
        approvalSnippet: (comment.text ?? "").substring(0, 200),
      };
    }
  }

  return { changed: true, approved: false, newCommentCount: totalCount, approvalSnippet: null };
}

interface PrChangeResult {
  prStatus: "active" | "completed" | "abandoned";
  threadChanged: boolean;
  buildChanged: boolean;
  commentChanged: boolean;
  newThreadCount: number;
  newCommentCount: number;
  newBuildResultId: string | null;
  newBuildStatus: string | null;
  latestActivityAt: string | null;
}

/**
 * Checks whether a PR changed since the last babysit observation.
 */
async function checkPrChanged(
  gitApi: IGitApi,
  repoName: string,
  project: string,
  prId: number,
  lastThreadCount: number,
  lastCommentCount: number,
  lastBuildResultId: string | null,
): Promise<PrChangeResult> {
  const pr = await gitApi.getPullRequest(repoName, prId, project);

  // Map PR status: 1=active, 2=abandoned, 3=completed
  const statusMap: Record<number, "active" | "completed" | "abandoned"> = {
    1: "active", 2: "abandoned", 3: "completed",
  };
  const prStatus = statusMap[pr.status ?? 1] ?? "active";

  // Thread/comment counts
  const threads = await gitApi.getThreads(repoName, prId, project);
  const allThreads = threads ?? [];
  const newThreadCount = allThreads.length;
  let newCommentCount = 0;
  for (const t of allThreads) {
    newCommentCount += (t.comments ?? []).filter((c: any) => (c as any).commentType !== 2).length;
  }

  // Build status — query builds for the source branch
  let newBuildResultId: string | null = null;
  let newBuildStatus: string | null = null;
  try {
    const buildApi = await (gitApi as any).connection?.getBuildApi?.();
    if (buildApi) {
      const sourceBranch = (pr.sourceRefName ?? "").replace("refs/heads/", "");
      const builds = await buildApi.getBuilds(
        project, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, /*top*/ 1, undefined, undefined,
        undefined, undefined, sourceBranch ? `refs/heads/${sourceBranch}` : undefined,
      );
      if (builds && builds.length > 0) {
        const b = builds[0];
        newBuildResultId = `${b.id}:${b.status}:${b.result}`;
        newBuildStatus = `${b.status}/${b.result}`;
      }
    }
  } catch (err: any) {
    log("BuildApi", `Build status check failed (non-blocking): ${err?.message || err}`);
  }

  const latestActivityAt = allThreads.length > 0
    ? allThreads.reduce((latest, t) => {
        const comments = t.comments ?? [];
        for (const c of comments) {
          const d = c.publishedDate ? new Date(c.publishedDate).toISOString() : "";
          if (d > latest) latest = d;
        }
        return latest;
      }, "")
    : null;

  return {
    prStatus,
    threadChanged: newThreadCount !== lastThreadCount,
    buildChanged: newBuildResultId !== lastBuildResultId,
    commentChanged: newCommentCount !== lastCommentCount,
    newThreadCount,
    newCommentCount,
    newBuildResultId,
    newBuildStatus,
    latestActivityAt: latestActivityAt || null,
  };
}

/**
 * Applies interval, cap, timeout, and change gates for babysit runs.
 */
export function shouldInvokeBabysit(
  state: DevWorkItemState,
  checkResult: PrChangeResult,
  now: number,
): boolean {
  // Interval gate
  if (state.lastBabysitCheckAt) {
    const lastCheck = new Date(state.lastBabysitCheckAt).getTime();
    if (now < lastCheck + BABYSIT_INTERVAL_MS) return false;
  }
  // Invocation cap
  if (state.babysitInvocations >= BABYSIT_MAX_INVOCATIONS) return false;
  // Timeout (72h default)
  if (state.babysitStartedAt) {
    const started = new Date(state.babysitStartedAt).getTime();
    if (now > started + BABYSIT_TIMEOUT_MS) return false;
  }
  // No changes = no invocation
  if (!checkResult.threadChanged && !checkResult.buildChanged && !checkResult.commentChanged) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// Work item discovery
// ═══════════════════════════════════════════════════════════════════

interface DiscoveredWorkItem {
  id: number;
  title: string;
  type: string;
  state: string;
  changedDate: string;
}

/**
 * Discovers active work items assigned to the configured developer.
 */
async function discoverWorkItems(
  witApi: IWorkItemTrackingApi,
  project: string,
  developerUpn: string,
): Promise<DiscoveredWorkItem[]> {
  const wiql = {
    query: `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.ChangedDate]
            FROM WorkItems
            WHERE [System.AssignedTo] = '${developerUpn}'
              AND [System.State] NOT IN ('Closed', 'Done', 'Removed')
              AND [System.WorkItemType] IN ('User Story', 'Bug', 'Task', 'Feature')
            ORDER BY [System.ChangedDate] DESC`,
  };

  const result = await witApi.queryByWiql(wiql, { project });
  const ids = (result.workItems ?? []).map(wi => wi.id!).filter(id => id != null);

  if (ids.length === 0) return [];

  const fields = ["System.Id", "System.Title", "System.State", "System.WorkItemType", "System.ChangedDate"];
  const workItems = await witApi.getWorkItems(ids, fields, undefined, undefined, undefined, project);

  return (workItems ?? []).map(wi => ({
    id: wi.id!,
    title: wi.fields?.["System.Title"] ?? "(no title)",
    type: wi.fields?.["System.WorkItemType"] ?? "Unknown",
    state: wi.fields?.["System.State"] ?? "Unknown",
    changedDate: wi.fields?.["System.ChangedDate"] ? new Date(wi.fields["System.ChangedDate"]).toISOString() : "",
  }));
}

// ═══════════════════════════════════════════════════════════════════
// Claude execution
// ═══════════════════════════════════════════════════════════════════

interface RunClaudeOpts {
  sessionId?: string;
  timeoutMs?: number;
}

/**
 * Runs Claude in a worktree with the Azure DevOps MCP configuration wired in.
 */
function runClaude(
  prompt: string,
  cwd: string,
  workItemId: number,
  repo: RepoConfig,
  opts?: RunClaudeOpts,
): Promise<{ exitCode: number; output: string; sessionId: string }> {
  const sessionId = opts?.sessionId ?? randomUUID();
  const timeoutMs = opts?.timeoutMs ?? CLAUDE_TIMEOUT_MS;

  return new Promise((resolve) => {
    log(repo.name, `[Claude] Spawning for WI #${workItemId} | Session: ${sessionId} | Timeout: ${timeoutMs / 60000}min`);

    saveSession({
      sessionId, workItemId, repo: repo.repository, worktreePath: cwd,
      startedAt: new Date().toISOString(),
    });

    const env = { ...process.env };
    delete env.CLAUDECODE;

    // MCP config
    const mcpConfigPath = path.join(cwd, ".mcp-review.json");
    fs.writeFileSync(mcpConfigPath, JSON.stringify({
      mcpServers: {
        "azure-devops": {
          type: "stdio", command: "cmd",
          args: ["/c", "npx", "-y", "@achieveai/azuredevops-mcp@1.3.18"],
          env: {
            AZURE_DEVOPS_ORG_URL: repo.orgUrl,
            AZURE_DEVOPS_PROJECT: repo.project,
            AZURE_DEVOPS_REPOSITORY: repo.repository,
            AZURE_DEVOPS_IS_ON_PREMISES: "false",
            ...(process.env.AZURE_DEVOPS_PAT ? { AZURE_DEVOPS_PAT: process.env.AZURE_DEVOPS_PAT } : {}),
          },
        },
      },
    }, null, 2));

    const child = spawn("claude", [
      "-p", "--dangerously-skip-permissions", "--model", "opus",
      "--session-id", sessionId,
      "--mcp-config", mcpConfigPath, "--",
      "-",
    ], { cwd, stdio: ["pipe", "pipe", "pipe"], env, shell: true });

    if (child.stdin) {
      child.stdin.on("error", () => {}); // prevent unhandled stream error
      child.stdin.write(prompt);
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    const timeout = setTimeout(() => {
      killed = true;
      logErr(repo.name, `[Claude] WI #${workItemId} timed out after ${timeoutMs / 60000} min, killing.`);
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      for (const line of text.split("\n").filter((l: string) => l.trim())) {
        log(repo.name, `  [WI#${workItemId}] ${line}`);
      }
    });

    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logErr(repo.name, `[Claude] WI #${workItemId} spawn failed: ${err.message}`);
      resolve({ exitCode: 1, output: `spawn error: ${err.message}`, sessionId });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

      let resultPath = "";
      try {
        if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
        resultPath = path.join(RESULTS_DIR, `wi-${workItemId}-${Date.now()}.md`);
        fs.writeFileSync(resultPath, output);
      } catch (fsErr: any) {
        logErr(repo.name, `[Claude] Failed to save result file: ${fsErr.message}`);
      }

      const suffix = killed ? " (timed out)" : "";
      log(repo.name, `[Claude] WI #${workItemId} complete (exit ${code})${suffix}.${resultPath ? ` Saved to ${resultPath}` : ""}`);

      saveSession({
        sessionId, workItemId, repo: repo.repository, worktreePath: cwd,
        completedAt: new Date().toISOString(),
        exitCode: killed ? 1 : (code ?? 1), resultPath,
      });

      resolve({ exitCode: killed ? 1 : (code ?? 1), output, sessionId });
    });
  });
}

/**
 * Runs a primary Claude phase and then follows with context summarization.
 */
async function runWithMemory(
  primaryPrompt: string,
  cwd: string,
  workItemId: number,
  title: string,
  repo: RepoConfig,
  phaseSessionId?: string | null,
): Promise<{ exitCode: number; output: string; sessionId: string; contextFilePath: string }> {
  // Step A: primary session
  const result = await runClaude(primaryPrompt, cwd, workItemId, repo, {
    sessionId: phaseSessionId ?? undefined,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  });

  // Step B: summarize (always, regardless of exit code)
  try {
    const contextPath = path.resolve(cwd, `../../.scratchpad/wi-${workItemId}/context.md`);
    let existingContext: string | null = null;
    if (fs.existsSync(contextPath)) {
      existingContext = fs.readFileSync(contextPath, "utf-8");
    }

    const summarizePrompt = buildSummarizePrompt(workItemId, title, cwd, result.output, existingContext);
    await runClaude(summarizePrompt, cwd, workItemId, repo, { timeoutMs: SUMMARIZE_TIMEOUT_MS });

    log(repo.name, `[Memory] Summarize complete for WI #${workItemId}`);
  } catch (err: any) {
    logErr(repo.name, `[Memory] Summarize failed for WI #${workItemId}: ${err.message}`);
  }

  // Return result with resolved context path so callers can wire it into state
  const resolvedContextPath = path.resolve(cwd, `../../.scratchpad/wi-${workItemId}/context.md`);
  return { ...result, contextFilePath: resolvedContextPath };
}

/**
 * Extracts architectural learnings after a work item completes (PR merged).
 * Lightweight call — reads the WI's context.md and appends concise entries
 * to the shared architecture-knowledge.md file.
 */
async function extractKnowledge(
  workItemId: number,
  title: string,
  contextFilePath: string | null,
  cwd: string,
  repo: RepoConfig,
): Promise<void> {
  try {
    const prompt = buildKnowledgeExtractionPrompt(workItemId, title, contextFilePath, KNOWLEDGE_FILE);
    await runClaude(prompt, cwd, workItemId, repo, { timeoutMs: SUMMARIZE_TIMEOUT_MS });
    log(repo.name, `[Knowledge] Extraction complete for WI #${workItemId}`);
  } catch (err: any) {
    logErr(repo.name, `[Knowledge] Extraction failed for WI #${workItemId}: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Custom prompt loading
// ═══════════════════════════════════════════════════════════════════

/**
 * Loads a prompt file when it contains substantive instructions.
 */
function loadPromptFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content || content.split("\n").every(l => l.startsWith("#") || l.startsWith("<!--") || l.trim() === "")) return "";
  return content;
}

/**
 * Loads the global and per-repo developer prompt customizations.
 */
function loadCustomPrompt(repoName?: string): string {
  const globalFile = path.join(__dirname, "..", "dev-prompt.md");
  const global = loadPromptFile(globalFile);
  let perRepo = "";
  if (repoName) {
    perRepo = loadPromptFile(path.join(__dirname, "..", `dev-prompt-${repoName}.md`));
  }
  return [global, perRepo].filter(Boolean).join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════
// handleImplementationResult
// ═══════════════════════════════════════════════════════════════════

/**
 * Processes the result of a Claude implementation invocation.
 * Transitions the work item to pr_babysitting on success, applies exponential
 * backoff on failure, or abandons after max attempts.
 */
async function handleImplementationResult(
  state: DevStateFile,
  itemKey: string,
  result: { exitCode: number; output: string; sessionId: string },
  repoName: string,
  repo: RepoConfig,
  gitApi: IGitApi,
): Promise<void> {
  const item = state.items[itemKey];
  const now = new Date().toISOString();
  const parsed = parseResultBlock(result.output);
  const status = parsed?.status ?? (result.exitCode === 0 ? "unknown" : "failed");

  // Always track session state
  item.lastClaudeSessionId = result.sessionId;
  item.lastClaudeExitCode = result.exitCode;
  item.lastInvokedAt = now;
  item.updatedAt = now;
  item.implSessionId = result.sessionId;

  if (status === "success" || (result.exitCode === 0 && status === "unknown")) {
    let prId = parsed?.pull_request_id ? parseInt(parsed.pull_request_id, 10) : NaN;

    // Fallback: scan output for PR ID patterns
    if (isNaN(prId) || prId <= 0) {
      const fallbackId = extractPrIdFallback(result.output);
      if (fallbackId) {
        prId = fallbackId;
        log(repoName, `[WI-${item.workItemId}] PR ID found via fallback: #${prId}`);
      }
    }

    if (!isNaN(prId) && prId > 0) {
      // Success with PR → transition to babysitting
      item.state = "pr_babysitting";
      item.pullRequestId = prId;
      item.pullRequestUrl = parsed?.pull_request_url || null;
      item.branchName = parsed?.branch_name || null;
      item.headCommitId = parsed?.head_commit_id || null;
      item.pullRequestStatus = "active";
      item.babysitStartedAt = now;
      item.babysitInvocations = 0;
      item.babysitConsecutiveFailures = 0;
      item.babysitSessionId = null;
      item.babysitSessionTurnCount = 0;

      // Snapshot baseline PR state for change detection
      try {
        const baseline = await checkPrChanged(
          gitApi, repo.repository, repo.project, prId,
          0, 0, null,
        );
        item.lastPrThreadCount = baseline.newThreadCount;
        item.lastPrCommentCount = baseline.newCommentCount;
        item.lastBuildResultId = baseline.newBuildResultId;
        item.lastBuildStatus = baseline.newBuildStatus;
        item.lastPrLatestActivityAt = baseline.latestActivityAt;
      } catch (err: any) {
        logErr(repoName, `[WI-${item.workItemId}] Failed to snapshot PR baseline: ${err.message}`);
      }

      log(repoName, `[WI-${item.workItemId}] ✓ Implementation complete → PR #${prId} → babysitting`);
      logActivity({ timestamp: now, repo: repoName, event: "impl_success", workItemId: item.workItemId, prId, details: parsed?.summary });
    } else {
      // Success but no PR ID — stay in implementing for retry
      log(repoName, `[WI-${item.workItemId}] ⚠ Implementation reported success but no PR ID found — will retry`);
      logActivity({ timestamp: now, repo: repoName, event: "impl_no_pr", workItemId: item.workItemId, details: "No PR ID in result block or output" });
    }
  } else if (status === "blocked") {
    // Claude used HITL or needs user input — stay in implementing
    log(repoName, `[WI-${item.workItemId}] ⏸ Implementation blocked — awaiting user input via HITL`);
    logActivity({ timestamp: now, repo: repoName, event: "impl_blocked", workItemId: item.workItemId, details: parsed?.summary });
  } else {
    // Failed or non-zero exit code
    item.implementationAttempts += 1;
    item.lastFailureReason = parsed?.summary || `Exit code ${result.exitCode}`;

    if (item.implementationAttempts >= IMPLEMENTATION_MAX_ATTEMPTS) {
      item.state = "abandoned";
      log(repoName, `[WI-${item.workItemId}] ✗ Abandoned after ${item.implementationAttempts} failed attempts: ${item.lastFailureReason}`);
      logActivity({ timestamp: now, repo: repoName, event: "impl_abandoned", workItemId: item.workItemId, details: item.lastFailureReason });
    } else {
      // Exponential backoff: 5m → 10m → 20m → 40m ...
      const backoffMs = 5 * 60 * 1000 * Math.pow(2, item.implementationAttempts - 1);
      item.backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      log(repoName, `[WI-${item.workItemId}] ✗ Implementation failed (attempt ${item.implementationAttempts}), backoff until ${item.backoffUntil}: ${item.lastFailureReason}`);
      logActivity({ timestamp: now, repo: repoName, event: "impl_failed", workItemId: item.workItemId, details: `Attempt ${item.implementationAttempts}: ${item.lastFailureReason}` });
    }
  }

  saveDevState(repoName, state);
}

// ═══════════════════════════════════════════════════════════════════
// handleBabysitResult
// ═══════════════════════════════════════════════════════════════════

/**
 * Processes the result of a Claude babysit invocation.
 * Transitions to completed/abandoned on terminal statuses, updates session
 * tracking, and detects consecutive failure streaks.
 */
function handleBabysitResult(
  state: DevStateFile,
  itemKey: string,
  result: { exitCode: number; output: string; sessionId: string },
  repo: RepoConfig,
): void {
  const item = state.items[itemKey];
  const now = new Date().toISOString();
  const parsed = parseResultBlock(result.output);
  const status = parsed?.status ?? (result.exitCode === 0 ? "no_action" : "failed");

  // Always update session tracking
  item.babysitSessionId = result.sessionId;
  item.babysitSessionTurnCount += 1;
  item.babysitInvocations += 1; // count every invocation for the BABYSIT_MAX_INVOCATIONS cap
  item.updatedAt = now;

  if (status === "completed") {
    item.state = "completed";
    item.pullRequestStatus = "completed";
    log(repo.name, `[WI-${item.workItemId}] ✓ PR merged — work item completed`);
    logActivity({ timestamp: now, repo: repo.name, event: "babysit_completed", workItemId: item.workItemId, prId: item.pullRequestId ?? undefined });

    // Clean up worktree
    try {
      cleanupWorkItemWorktree(item.worktreePath, repo.localPath);
    } catch (err: any) {
      logErr(repo.name, `[WI-${item.workItemId}] Worktree cleanup failed: ${err.message}`);
    }
  } else if (status === "abandoned") {
    item.state = "abandoned";
    item.pullRequestStatus = "abandoned";
    log(repo.name, `[WI-${item.workItemId}] ✗ PR abandoned`);
    logActivity({ timestamp: now, repo: repo.name, event: "babysit_abandoned", workItemId: item.workItemId, prId: item.pullRequestId ?? undefined });
    // Keep worktree for forensic investigation
  } else if (status === "no_action" || status === "updated_pr") {
    item.lastBabysitClaudeAt = now;
    item.babysitConsecutiveFailures = 0; // reset streak on success
    if (status === "updated_pr") {
      item.headCommitId = parsed?.head_commit_id || item.headCommitId;
    }
    log(repo.name, `[WI-${item.workItemId}] Babysit ${status}: ${parsed?.notes || "ok"}`);
    logActivity({ timestamp: now, repo: repo.name, event: `babysit_${status}`, workItemId: item.workItemId, prId: item.pullRequestId ?? undefined });
  } else {
    // Failed or non-zero exit
    item.babysitConsecutiveFailures = (item.babysitConsecutiveFailures ?? 0) + 1;
    const failReason = parsed?.notes || `Exit code ${result.exitCode}`;
    logErr(repo.name, `[WI-${item.workItemId}] Babysit failed (consecutive: ${item.babysitConsecutiveFailures}, total: ${item.babysitInvocations}): ${failReason}`);
    logActivity({ timestamp: now, repo: repo.name, event: "babysit_failed", workItemId: item.workItemId, prId: item.pullRequestId ?? undefined, details: failReason });

    // 5 consecutive failures → abandon
    if (item.babysitConsecutiveFailures >= 5) {
      item.state = "abandoned";
      item.pullRequestStatus = "abandoned";
      log(repo.name, `[WI-${item.workItemId}] ✗ Abandoned after ${item.babysitInvocations} consecutive babysit failures`);
      logActivity({ timestamp: now, repo: repo.name, event: "babysit_streak_abandoned", workItemId: item.workItemId, prId: item.pullRequestId ?? undefined });
    }
  }

  // Reset session if turn count exceeds threshold (fresh context next cycle)
  if (item.babysitSessionTurnCount >= BABYSIT_SESSION_RESET_TURNS) {
    item.babysitSessionId = null;
    item.babysitSessionTurnCount = 0;
    log(repo.name, `[WI-${item.workItemId}] Session reset after ${BABYSIT_SESSION_RESET_TURNS} turns`);
  }

  saveDevState(repo.name, state);
}

// ═══════════════════════════════════════════════════════════════════
// DevRepoWorker
// ═══════════════════════════════════════════════════════════════════

/**
 * Per-repo worker that discovers work items, prioritizes them, and drives
 * each through the lifecycle: discovered → plan → approved → implementing →
 * pr_babysitting → completed.
 *
 * Items are processed in strict priority order within each cycle:
 *   1. Babysit existing PRs
 *   2. Check plan approvals
 *   3. Retry errored implementations
 *   4. Start approved work
 *   5. Post new plans
 */
class DevRepoWorker {
  private repo: RepoConfig;
  private state: DevStateFile;
  private gitApi!: IGitApi;
  private witApi!: IWorkItemTrackingApi;
  private customPrompt: string;
  private allRepos: RepoConfig[];

  /** Actions taken this cycle (for dashboard stats). */
  public actionsThisCycle = 0;
  /** Errors encountered this cycle. */
  public errorsThisCycle = 0;

  constructor(repo: RepoConfig, allRepos: RepoConfig[]) {
    this.repo = repo;
    this.allRepos = allRepos;
    this.state = loadDevState(repo.name);
    this.customPrompt = loadCustomPrompt(repo.name);
  }

  /** Initialise ADO API clients from a shared connection. */
  async init(connection: azdev.WebApi): Promise<void> {
    this.gitApi = await connection.getGitApi();
    this.witApi = await connection.getWorkItemTrackingApi();
    log(this.repo.name, `[DevWorker] Initialized — ${Object.keys(this.state.items).length} tracked items`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Discovery
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Queries ADO for assigned work items and merges them into tracked state.
   * New items are added as "discovered"; removed/closed items are updated.
   */
  private async discover(): Promise<void> {
    let discovered: { id: number; title: string; type: string; state: string; changedDate: string }[];
    try {
      discovered = await discoverWorkItems(this.witApi, this.repo.project, DEVELOPER_UPN);
    } catch (err: any) {
      logErr(this.repo.name, `[Discovery] Failed: ${err.message}`);
      this.errorsThisCycle++;
      return;
    }

    const discoveredIds = new Set(discovered.map((w) => w.id));
    const now = new Date().toISOString();
    let added = 0;
    let removed = 0;

    // Add new work items
    for (const wi of discovered) {
      const key = String(wi.id);
      if (!this.state.items[key]) {
        const wtResult = ensureWorkItemWorktree(this.repo.localPath, wi.id, this.repo.name);
        this.state.items[key] = createDefaultWorkItemState(wi.id, wi.title, wtResult.worktreePath);
        this.state.items[key].baseBranch = wtResult.baseBranch;
        this.state.items[key].worktreeStatus = wtResult.worktreeStatus;
        added++;
        log(this.repo.name, `[Discovery] New: WI-${wi.id} "${wi.title}" → discovered`);
      } else {
        // Update title in case it changed
        this.state.items[key].title = wi.title;
      }
    }

    // Handle items no longer assigned (only if they're not actively in WIP)
    for (const key of Object.keys(this.state.items)) {
      const item = this.state.items[key];
      if (!discoveredIds.has(item.workItemId) && item.state !== "completed" && item.state !== "abandoned") {
        if (isWipState(item.state)) {
          // In-progress items stay — the developer may have unassigned temporarily
          log(this.repo.name, `[Discovery] WI-${item.workItemId} no longer assigned but in WIP (${item.state}) — keeping`);
        } else {
          item.state = "completed";
          item.updatedAt = now;
          removed++;
          log(this.repo.name, `[Discovery] WI-${item.workItemId} no longer assigned → completed`);
        }
      }
    }

    this.state.lastDiscoveryAt = now;
    saveDevState(this.repo.name, this.state);

    const totalTracked = Object.keys(this.state.items).length;
    const wipCount = countWipItems(this.state);
    log(this.repo.name, `[Discovery] Done: ${discovered.length} assigned, +${added} new, -${removed} removed, ${wipCount} WIP, ${totalTracked} total tracked`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 1: Babysit existing PRs
  // ─────────────────────────────────────────────────────────────────────────

  /** Checks and babysits all items in pr_babysitting state. */
  private async processBabysitting(): Promise<void> {
    const items = this.itemsByState("pr_babysitting");
    if (items.length === 0) return;

    log(this.repo.name, `[P1-Babysit] ${items.length} PR(s) to check`);

    for (const [key, item] of items) {
      try {
        await this.babysitOneItem(key, item);
      } catch (err: any) {
        logErr(this.repo.name, `[P1-Babysit] WI-${item.workItemId} error: ${err.message}`);
        this.errorsThisCycle++;
      }
    }
  }

  private async babysitOneItem(key: string, item: DevWorkItemState): Promise<void> {
    if (!item.pullRequestId) {
      logErr(this.repo.name, `[P1-Babysit] WI-${item.workItemId} in babysitting but no PR ID — skipping`);
      return;
    }

    // Always check PR status, even if we don't invoke Claude
    const checkResult = await checkPrChanged(
      this.gitApi, this.repo.repository, this.repo.project, item.pullRequestId,
      item.lastPrThreadCount, item.lastPrCommentCount, item.lastBuildResultId,
    );

    const now = new Date().toISOString();

    // Handle terminal PR states
    if (checkResult.prStatus === "completed") {
      item.state = "completed";
      item.pullRequestStatus = "completed";
      item.updatedAt = now;
      log(this.repo.name, `[P1-Babysit] WI-${item.workItemId} PR #${item.pullRequestId} merged externally → completed`);
      logActivity({ timestamp: now, repo: this.repo.name, event: "pr_merged", workItemId: item.workItemId, prId: item.pullRequestId });
      await extractKnowledge(item.workItemId, item.title, item.contextFilePath, item.worktreePath ?? this.repo.localPath, this.repo);
      try { cleanupWorkItemWorktree(item.worktreePath, this.repo.localPath); } catch (err: any) {
        logErr(this.repo.name, `[P1-Babysit] WI-${item.workItemId} Worktree cleanup failed: ${err.message}`);
      }
      saveDevState(this.repo.name, this.state);
      this.actionsThisCycle++;
      return;
    }

    if (checkResult.prStatus === "abandoned") {
      item.state = "abandoned";
      item.pullRequestStatus = "abandoned";
      item.updatedAt = now;
      log(this.repo.name, `[P1-Babysit] WI-${item.workItemId} PR #${item.pullRequestId} abandoned externally`);
      logActivity({ timestamp: now, repo: this.repo.name, event: "pr_abandoned", workItemId: item.workItemId, prId: item.pullRequestId });
      saveDevState(this.repo.name, this.state);
      this.actionsThisCycle++;
      return;
    }

    // Capture old baselines BEFORE updating (for delta computation)
    const prevThreadCount = item.lastPrThreadCount;
    const prevCommentCount = item.lastPrCommentCount;

    // Gate check BEFORE updating lastBabysitCheckAt
    const shouldInvoke = shouldInvokeBabysit(item, checkResult, Date.now());

    // Now update baseline counts (always, even when not invoking Claude)
    item.lastPrThreadCount = checkResult.newThreadCount;
    item.lastPrCommentCount = checkResult.newCommentCount;
    item.lastBuildResultId = checkResult.newBuildResultId;
    item.lastBuildStatus = checkResult.newBuildStatus;
    item.lastPrLatestActivityAt = checkResult.latestActivityAt;
    item.lastBabysitCheckAt = now;

    // Should we invoke Claude?
    if (shouldInvoke) {
      log(this.repo.name, `[P1-Babysit] WI-${item.workItemId} PR #${item.pullRequestId} — invoking Claude`);

      const changeContext = {
        threadDelta: checkResult.newThreadCount - prevThreadCount,
        commentDelta: checkResult.newCommentCount - prevCommentCount,
        buildChanged: checkResult.buildChanged,
        newBuildStatus: checkResult.newBuildStatus ?? undefined,
        testChanged: false, // TODO: wire up test summary comparison
      };

      const prompt = buildBabysitPrompt(
        { workItemId: item.workItemId, title: item.title },
        item.pullRequestId,
        item.worktreePath,
        changeContext,
        { orgUrl: this.repo.orgUrl, project: this.repo.project, repository: this.repo.repository },
        item.contextFilePath,
      );

      const result = await runWithMemory(
        prompt, item.worktreePath, item.workItemId, item.title,
        this.repo, item.babysitSessionId,
      );

      item.contextFilePath = result.contextFilePath;
      item.lastContextWrittenAt = new Date().toISOString();
      handleBabysitResult(this.state, key, result, this.repo);

      // If babysit handler transitioned to completed, extract knowledge
      if (item.state === "completed") {
        await extractKnowledge(item.workItemId, item.title, item.contextFilePath, item.worktreePath ?? this.repo.localPath, this.repo);
      }

      this.actionsThisCycle++;
    } else {
      // No action needed — just save the updated baseline counts
      item.updatedAt = now;
      saveDevState(this.repo.name, this.state);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 2: Check plan approvals
  // ─────────────────────────────────────────────────────────────────────────

  /** Scans WI comments for approval keywords on items awaiting plan approval. */
  private async checkApprovals(): Promise<void> {
    const items = this.itemsByState("needs_plan");
    if (items.length === 0) return;

    log(this.repo.name, `[P2-Approval] ${items.length} item(s) awaiting plan approval`);

    for (const [key, item] of items) {
      try {
        const scan = await scanWiApproval(
          this.witApi, this.repo.project, item.workItemId, item.lastWiCommentCount,
        );

        if (scan.approved) {
          item.state = "plan_approved";
          item.approvalDetectedAt = new Date().toISOString();
          item.approvalCommentText = scan.approvalSnippet;
          item.lastWiCommentCount = scan.newCommentCount;
          item.updatedAt = new Date().toISOString();
          log(this.repo.name, `[P2-Approval] WI-${item.workItemId} ✓ Plan approved: "${scan.approvalSnippet?.slice(0, 60)}"`);
          logActivity({ timestamp: item.updatedAt, repo: this.repo.name, event: "plan_approved", workItemId: item.workItemId });
          this.actionsThisCycle++;
        } else if (scan.changed) {
          item.lastWiCommentCount = scan.newCommentCount;
          item.lastWiCommentCheckedAt = new Date().toISOString();
          item.updatedAt = new Date().toISOString();
          log(this.repo.name, `[P2-Approval] WI-${item.workItemId} New comments but no approval keyword`);
        }
        // If unchanged, skip entirely — no logging needed

        saveDevState(this.repo.name, this.state);
      } catch (err: any) {
        logErr(this.repo.name, `[P2-Approval] WI-${item.workItemId} error: ${err.message}`);
        this.errorsThisCycle++;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 3: Retry errored implementations
  // ─────────────────────────────────────────────────────────────────────────

  /** Retries implementation for items whose backoff period has expired. */
  private async retryImplementations(globalWipCount: number): Promise<number> {
    const now = Date.now();
    const items = this.itemsByState("implementing").filter(([, item]) => {
      if (!item.backoffUntil) return false;
      return new Date(item.backoffUntil).getTime() <= now;
    });

    if (items.length === 0) return globalWipCount;

    log(this.repo.name, `[P3-Retry] ${items.length} item(s) ready for retry`);

    for (const [key, item] of items) {
      // No WIP gate for retries — these items already count toward WIP

      try {
        // Ensure worktree is ready
        const wt = ensureWorkItemWorktree(this.repo.localPath, item.workItemId, this.repo.name);
        item.worktreePath = wt.worktreePath;
        item.worktreeStatus = wt.worktreeStatus;
        item.backoffUntil = null;

        log(this.repo.name, `[P3-Retry] WI-${item.workItemId} retrying implementation (attempt ${item.implementationAttempts + 1})`);

        const prompt = buildImplementationPrompt(
          { workItemId: item.workItemId, title: item.title },
          item.worktreePath,
          item.planCommentId,
          { orgUrl: this.repo.orgUrl, project: this.repo.project, repository: this.repo.repository },
          this.customPrompt,
          item.contextFilePath,
        );

        const result = await runWithMemory(
          prompt, item.worktreePath, item.workItemId, item.title,
          this.repo, item.implSessionId,
        );

        item.contextFilePath = result.contextFilePath;
        item.lastContextWrittenAt = new Date().toISOString();
        await handleImplementationResult(this.state, key, result, this.repo.name, this.repo, this.gitApi);
        this.actionsThisCycle++;
      } catch (err: any) {
        logErr(this.repo.name, `[P3-Retry] WI-${item.workItemId} error: ${err.message}`);
        this.errorsThisCycle++;
      }

      // Re-read globalWipCount after each item (state may have changed)
      globalWipCount = this.calculateGlobalWip();
    }

    return globalWipCount;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 4: Start approved work
  // ─────────────────────────────────────────────────────────────────────────

  /** Begins implementation for items with approved plans. */
  private async startApproved(globalWipCount: number): Promise<number> {
    const items = this.itemsByState("plan_approved");
    if (items.length === 0) return globalWipCount;

    log(this.repo.name, `[P4-Implement] ${items.length} approved item(s) ready`);

    for (const [key, item] of items) {
      if (globalWipCount >= MAX_WIP_ITEMS) {
        log(this.repo.name, `[P4-Implement] WIP limit (${MAX_WIP_ITEMS}) reached — deferring remaining`);
        break;
      }

      try {
        item.state = "implementing";
        item.implementationAttempts = 0;
        item.updatedAt = new Date().toISOString();
        saveDevState(this.repo.name, this.state);

        // Ensure worktree
        const wt = ensureWorkItemWorktree(this.repo.localPath, item.workItemId, this.repo.name);
        item.worktreePath = wt.worktreePath;
        item.worktreeStatus = wt.worktreeStatus;

        log(this.repo.name, `[P4-Implement] WI-${item.workItemId} starting implementation`);

        const prompt = buildImplementationPrompt(
          { workItemId: item.workItemId, title: item.title },
          item.worktreePath,
          item.planCommentId,
          { orgUrl: this.repo.orgUrl, project: this.repo.project, repository: this.repo.repository },
          this.customPrompt,
          item.contextFilePath,
        );

        const result = await runWithMemory(
          prompt, item.worktreePath, item.workItemId, item.title,
          this.repo, null,
        );

        item.contextFilePath = result.contextFilePath;
        item.lastContextWrittenAt = new Date().toISOString();
        item.implSessionId = result.sessionId;
        await handleImplementationResult(this.state, key, result, this.repo.name, this.repo, this.gitApi);
        this.actionsThisCycle++;
      } catch (err: any) {
        logErr(this.repo.name, `[P4-Implement] WI-${item.workItemId} error: ${err.message}`);
        // Rollback state to plan_approved so it can be retried next cycle
        item.state = "plan_approved";
        item.implementationAttempts = 0;
        item.updatedAt = new Date().toISOString();
        saveDevState(this.repo.name, this.state);
        this.errorsThisCycle++;
      }

      globalWipCount = this.calculateGlobalWip();
    }

    return globalWipCount;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 5: Post new plans
  // ─────────────────────────────────────────────────────────────────────────

  /** Posts design plans for newly discovered work items. */
  private async postPlans(globalWipCount: number): Promise<number> {
    const items = this.itemsByState("discovered");
    if (items.length === 0) return globalWipCount;

    log(this.repo.name, `[P5-Plan] ${items.length} discovered item(s) to plan`);

    for (const [key, item] of items) {
      if (globalWipCount >= MAX_WIP_ITEMS) {
        log(this.repo.name, `[P5-Plan] WIP limit (${MAX_WIP_ITEMS}) reached — deferring planning`);
        break;
      }

      try {
        item.state = "needs_plan";
        item.updatedAt = new Date().toISOString();
        saveDevState(this.repo.name, this.state);

        // Ensure worktree
        const wt = ensureWorkItemWorktree(this.repo.localPath, item.workItemId, this.repo.name);
        item.worktreePath = wt.worktreePath;
        item.baseBranch = wt.baseBranch;
        item.worktreeStatus = wt.worktreeStatus;

        log(this.repo.name, `[P5-Plan] WI-${item.workItemId} posting plan`);

        const prompt = buildPlanPrompt(
          { workItemId: item.workItemId, title: item.title },
          item.worktreePath,
          { orgUrl: this.repo.orgUrl, project: this.repo.project, repository: this.repo.repository },
          this.customPrompt,
          item.contextFilePath,
        );

        const result = await runWithMemory(
          prompt, item.worktreePath, item.workItemId, item.title,
          this.repo, null,
        );

        item.contextFilePath = result.contextFilePath;
        item.lastContextWrittenAt = new Date().toISOString();
        item.planSessionId = result.sessionId;
        item.lastClaudeSessionId = result.sessionId;
        item.lastClaudeExitCode = result.exitCode;
        item.lastInvokedAt = new Date().toISOString();
        item.updatedAt = new Date().toISOString();

        // Parse plan result
        const parsed = parseResultBlock(result.output);
        if (parsed?.plan_comment_id) {
          const commentId = parseInt(parsed.plan_comment_id, 10);
          if (!isNaN(commentId) && commentId > 0) {
            item.planCommentId = commentId;
            item.planPostedAt = new Date().toISOString();
            log(this.repo.name, `[P5-Plan] WI-${item.workItemId} ✓ Plan posted as comment #${commentId}`);
          }
        }

        if (parsed?.status === "blocked") {
          log(this.repo.name, `[P5-Plan] WI-${item.workItemId} ⏸ Blocked — awaiting user input`);
        } else if (parsed?.status === "failed" || result.exitCode !== 0) {
          logErr(this.repo.name, `[P5-Plan] WI-${item.workItemId} planning failed: ${parsed?.summary || `exit ${result.exitCode}`}`);
        }

        logActivity({ timestamp: new Date().toISOString(), repo: this.repo.name, event: "plan_posted", workItemId: item.workItemId, details: parsed?.summary });
        saveDevState(this.repo.name, this.state);
        this.actionsThisCycle++;
      } catch (err: any) {
        logErr(this.repo.name, `[P5-Plan] WI-${item.workItemId} error: ${err.message}`);
        // Rollback state to discovered so it can be retried next cycle
        item.state = "discovered";
        item.updatedAt = new Date().toISOString();
        saveDevState(this.repo.name, this.state);
        this.errorsThisCycle++;
      }

      globalWipCount = this.calculateGlobalWip();
    }

    return globalWipCount;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main cycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Runs a single processing cycle for this repo.
   * Discovers work items, then processes them in strict priority order.
   *
   * @param globalWipCount - Current WIP count across ALL repos
   */
  async runOnce(globalWipCount: number): Promise<void> {
    const cycleStart = Date.now();
    this.actionsThisCycle = 0;
    this.errorsThisCycle = 0;

    // Reload state from disk (another process may have updated it)
    this.state = loadDevState(this.repo.name);

    log(this.repo.name, `[Cycle] Starting — global WIP: ${globalWipCount}/${MAX_WIP_ITEMS}`);

    // Phase 0: Discovery
    await this.discover();

    // Priority 1: Babysit existing PRs (always runs, regardless of WIP)
    await this.processBabysitting();

    // Priority 2: Check plan approvals (cheap — no Claude)
    await this.checkApprovals();

    // Recalculate WIP after babysit may have completed some items
    let wip = globalWipCount;

    // Priority 3: Retry errored implementations
    wip = await this.retryImplementations(wip);

    // Priority 4: Start approved work
    wip = await this.startApproved(wip);

    // Priority 5: Post new plans
    wip = await this.postPlans(wip);

    const duration = Math.round((Date.now() - cycleStart) / 1000);
    log(this.repo.name, `[Cycle] Complete in ${duration}s — ${this.actionsThisCycle} actions, ${this.errorsThisCycle} errors`);
    logActivity({ timestamp: new Date().toISOString(), repo: this.repo.name, event: "dev_cycle_end", details: `${this.actionsThisCycle} actions, ${this.errorsThisCycle} errors`, duration: Date.now() - cycleStart });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Returns items filtered by lifecycle state as [key, item] pairs. */
  private itemsByState(targetState: DevLifecycleState): [string, DevWorkItemState][] {
    return Object.entries(this.state.items).filter(([, item]) => item.state === targetState);
  }

  /** Calculates WIP count across ALL repos (global). */
  private calculateGlobalWip(): number {
    let wip = 0;
    for (const r of this.allRepos) {
      wip += countWipItems(loadDevState(r.name));
    }
    return wip;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════════

/**
 * Prints a summary dashboard of all dev-daemon work items across all repos.
 * Reads dev-state-{repo}.json files and displays a box-drawn table.
 */
function printDevDashboard(): void {
  const W = 78; // inner width between ║ borders

  // Discover all state files
  const stateDir = path.join(__dirname, "..");
  let stateFiles: string[];
  try {
    stateFiles = fs.readdirSync(stateDir).filter((f) => f.startsWith("dev-state-") && f.endsWith(".json"));
  } catch {
    console.log("No dev state files found.");
    return;
  }

  if (stateFiles.length === 0) {
    console.log("No dev state files found.");
    return;
  }

  const pad = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const line = (content: string) => `║ ${pad(content, W)}║`;
  const sep = (left: string, right: string) => `${left}${"═".repeat(W + 1)}${right}`;

  console.log(`\n${sep("╔", "╗")}`);
  console.log(line(pad("Dev Daemon Dashboard", W)));
  console.log(sep("╠", "╣"));

  // Header row
  const hdr = `${"WI".padEnd(7)}${"Title".padEnd(28)}${"State".padEnd(16)}${"PR".padEnd(8)}${"Bsit#".padEnd(7)}${"Age".padEnd(12)}`;
  console.log(line(hdr));
  console.log(sep("╠", "╣"));

  let totalItems = 0;
  let totalWip = 0;

  for (const file of stateFiles) {
    const repoName = file.replace("dev-state-", "").replace(".json", "");
    let stateFile: DevStateFile;
    try {
      stateFile = JSON.parse(fs.readFileSync(path.join(stateDir, file), "utf-8")) as DevStateFile;
    } catch {
      console.log(line(`${repoName}: <corrupt state file>`));
      continue;
    }

    const items = Object.values(stateFile.items);
    if (items.length === 0) {
      console.log(line(`${repoName}: no tracked items`));
      continue;
    }

    console.log(line(`▸ ${repoName} (${items.length} items)`));

    for (const item of items) {
      totalItems++;
      if (isWipState(item.state)) totalWip++;

      const wiId = `#${item.workItemId}`.padEnd(7);
      const title = pad(item.title.slice(0, 26), 28);
      const state = pad(item.state, 16);
      const pr = item.pullRequestId ? `#${item.pullRequestId}`.padEnd(8) : "—".padEnd(8);
      const babysit = String(item.babysitInvocations).padEnd(7);
      const age = formatAge(item.discoveredAt);

      console.log(line(`${wiId}${title}${state}${pr}${babysit}${age}`));
    }
  }

  console.log(sep("╠", "╣"));
  console.log(line(`Total: ${totalItems} items, ${totalWip} WIP (limit: ${MAX_WIP_ITEMS})`));
  console.log(`${sep("╚", "╝")}\n`);
}

/** Formats a timestamp as a human-readable age string. */
function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ═══════════════════════════════════════════════════════════════════
// Entry points
// ═══════════════════════════════════════════════════════════════════

/**
 * Runs the developer daemon in a continuous loop.
 * Discovers work items, processes them through the lifecycle, and babysits PRs
 * on a configurable polling interval.
 */
async function devDaemonLoop(): Promise<void> {
  // Validate required config
  if (!DEVELOPER_UPN || DEVELOPER_UPN === "CHANGEME") {
    console.error("[DevDaemon] DEVELOPER_UPN is not set. Set it in .env or environment.");
    process.exit(1);
  }
  if (!DEV_WORKTREE_BASE) {
    console.error("[DevDaemon] DEV_WORKTREE_BASE is not set. Set it in .env or environment.");
    process.exit(1);
  }

  const repos: RepoConfig[] = JSON.parse(fs.readFileSync(REPOS_CONFIG, "utf-8"));
  const enabled = repos.filter((r) => r.enabled);

  if (enabled.length === 0) {
    console.error("[DevDaemon] No enabled repos in repos.json");
    process.exit(1);
  }

  console.log(`\n[DevDaemon] Starting with ${enabled.length} repo(s), polling every ${POLL_INTERVAL_MS / 60000} min`);
  console.log(`[DevDaemon] Developer: ${DEVELOPER_UPN}`);
  console.log(`[DevDaemon] WIP limit: ${MAX_WIP_ITEMS}`);
  console.log(`[DevDaemon] Repos: ${enabled.map((r) => r.name).join(", ")}`);

  // Shared connection (same org for all repos)
  const connection = await createConnection(enabled[0].orgUrl);

  // Create workers
  const workers: DevRepoWorker[] = [];
  for (const repo of enabled) {
    const worker = new DevRepoWorker(repo, enabled);
    await worker.init(connection);
    workers.push(worker);
  }

  // Graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n[DevDaemon] Shutting down after current cycle completes...");
  });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    const cycleStart = Date.now();
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[DevDaemon] Cycle starting at ${new Date().toISOString()}`);
    console.log(`${"═".repeat(60)}\n`);

    // Calculate global WIP across ALL repos
    let globalWip = 0;
    for (const repo of enabled) {
      const st = loadDevState(repo.name);
      globalWip += countWipItems(st);
    }

    // Run workers sequentially to avoid WIP count race conditions
    for (let i = 0; i < workers.length; i++) {
      if (stopping) break;

      try {
        await workers[i].runOnce(globalWip);
      } catch (err: any) {
        logErr("DevDaemon", `Worker ${enabled[i].name} error: ${err.message}\n${err.stack}`);
      }

      // Recalculate global WIP for next worker (previous worker may have changed counts)
      globalWip = 0;
      for (const repo of enabled) {
        const st = loadDevState(repo.name);
        globalWip += countWipItems(st);
      }
    }

    const cycleDuration = Math.round((Date.now() - cycleStart) / 1000);
    const totalActions = workers.reduce((n, w) => n + w.actionsThisCycle, 0);
    const totalErrors = workers.reduce((n, w) => n + w.errorsThisCycle, 0);

    console.log(`\n[DevDaemon] Cycle complete in ${cycleDuration}s: ${totalActions} actions, ${totalErrors} errors, ${globalWip} WIP`);
    printDevDashboard();

    if (stopping) break;

    console.log(`[DevDaemon] Next cycle in ${POLL_INTERVAL_MS / 60000} minutes...`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      const checkStop = setInterval(() => {
        if (stopping) { clearTimeout(timer); clearInterval(checkStop); resolve(); }
      }, 1000);
      timer.unref?.();
    });
  }

  console.log("[DevDaemon] Stopped.");
}

/**
 * Runs a single dev-daemon cycle across all repos, then exits.
 * Useful for testing or cron-based scheduling.
 */
async function devRunOnce(): Promise<void> {
  if (!DEVELOPER_UPN || DEVELOPER_UPN === "CHANGEME") {
    console.error("[DevDaemon] DEVELOPER_UPN is not set.");
    process.exit(1);
  }
  if (!DEV_WORKTREE_BASE) {
    console.error("[DevDaemon] DEV_WORKTREE_BASE is not set.");
    process.exit(1);
  }

  const repos: RepoConfig[] = JSON.parse(fs.readFileSync(REPOS_CONFIG, "utf-8"));
  const enabled = repos.filter((r) => r.enabled);

  if (enabled.length === 0) {
    console.error("[DevDaemon] No enabled repos in repos.json");
    process.exit(1);
  }

  const connection = await createConnection(enabled[0].orgUrl);

  const workers: DevRepoWorker[] = [];
  for (const repo of enabled) {
    const worker = new DevRepoWorker(repo, enabled);
    await worker.init(connection);
    workers.push(worker);
  }

  let globalWip = 0;
  for (const repo of enabled) {
    globalWip += countWipItems(loadDevState(repo.name));
  }

  for (let i = 0; i < workers.length; i++) {
    try {
      await workers[i].runOnce(globalWip);
    } catch (err: any) {
      logErr("DevDaemon", `Worker ${enabled[i].name} error: ${err.message}\n${err.stack}`);
    }

    // Recalculate WIP for next worker
    globalWip = 0;
    for (const repo of enabled) {
      globalWip += countWipItems(loadDevState(repo.name));
    }
  }

  printDevDashboard();
}

// ═══════════════════════════════════════════════════════════════════
// CLI dispatch
// ═══════════════════════════════════════════════════════════════════

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === "dashboard") {
    printDevDashboard();
  } else if (mode === "once") {
    devRunOnce().catch((err) => { console.error("Fatal:", err); process.exit(1); });
  } else {
    devDaemonLoop().catch((err) => { console.error("Fatal:", err); process.exit(1); });
  }
}
