/// <reference types="node" />
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import * as azdev from "azure-devops-node-api";
import { BearerCredentialHandler } from "azure-devops-node-api/handlers/bearertoken";
import { IGitApi } from "azure-devops-node-api/GitApi";
import { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi";
import { WorkItemExpand } from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces";
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
import { formatPrIdleAge, isPrIdle, PR_IDLE_THRESHOLD_HOURS } from "./pr-idle";
import {
  formatPrReviewWait,
  getPrReviewDecision,
} from "./pr-review-policy";
import { writeMcpConfig } from "./mcp-config";

// Enable encrypted persistent token cache
try {
  useIdentityPlugin(cachePersistencePlugin);
} catch {
  // Already registered
}

// ===========================================================================
// Auto-refreshing bearer token handler
// ===========================================================================
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

// ===========================================================================
// Configuration
// ===========================================================================
const REPOS_CONFIG = path.join(__dirname, "..", "repos.json");
const ACTIVITY_LOG = path.join(__dirname, "..", "activity.jsonl");
const SESSIONS_FILE = path.join(__dirname, "..", "sessions.jsonl");
const RESULTS_DIR = path.join(__dirname, "..", "review-results");
const CUSTOM_PROMPT_FILE = path.join(__dirname, "..", "review-prompt.md");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MINUTES ?? "10", 10) * 60 * 1000;
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const WARMUP_STAGGER_MS = parseInt(process.env.WARMUP_STAGGER_SECONDS ?? "30", 10) * 1000;
const MIN_REVIEW_LENGTH = 200;
const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";

// Optional: Bluebird MCP server via Agency (auto-detected from APPDATA)
const agencyCandidate = process.env.APPDATA
  ? path.join(process.env.APPDATA, "agency", "CurrentVersion", "agency.exe")
  : null;
const agencyPath = agencyCandidate && fs.existsSync(agencyCandidate) ? agencyCandidate : null;

interface RepoConfig {
  name: string;
  orgUrl: string;
  project: string;
  repository: string;
  localPath: string;
  worktreeCount: number;
  enabled: boolean;
}

// ===========================================================================
// Logging
// ===========================================================================
interface ActivityEntry {
  timestamp: string;
  repo: string;
  event: string;
  prId?: number;
  details?: string;
  duration?: number;
}

function logActivity(entry: ActivityEntry): void {
  try { fs.appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + "\n"); } catch { /* best effort */ }
}

function log(repo: string, msg: string): void {
  console.log(`[${repo}] ${msg}`);
}

function logErr(repo: string, msg: string): void {
  console.error(`[${repo}] ${msg}`);
}

// ===========================================================================
// Entra ID auth (shared across all repos — same org)
// ===========================================================================
const AUTH_RECORD_DIR = path.join(os.homedir(), ".azuredevops-mcp");

function orgUrlToLabel(orgUrl: string): string {
  return (orgUrl || "default").replace(/^https?:\/\//, "").replace(/[/\\:*?"<>|]+/g, "-").replace(/-+$/, "");
}

function loadAuthRecord(orgUrl: string): AuthenticationRecord | undefined {
  try {
    const filePath = path.join(AUTH_RECORD_DIR, `auth-record-${orgUrlToLabel(orgUrl)}.json`);
    if (!fs.existsSync(filePath)) return undefined;
    return deserializeAuthenticationRecord(fs.readFileSync(filePath, "utf-8"));
  } catch { return undefined; }
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

// ===========================================================================
// Git helpers (parameterized — no process.env dependency)
// ===========================================================================
function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function gitSafe(args: string, cwd: string): string | null {
  try { return git(args, cwd); } catch { return null; }
}

// ===========================================================================
// Worktree pool (parameterized)
// ===========================================================================
interface WorktreeSlot {
  id: string;
  path: string;
  busy: boolean;
}

interface WorktreePool {
  repoPath: string;
  poolDir: string;
  slots: WorktreeSlot[];
}

function initWorktreePool(repoPath: string, count: number): WorktreePool {
  const poolDir = path.join(repoPath, ".worktree-pool");
  if (!fs.existsSync(poolDir)) fs.mkdirSync(poolDir, { recursive: true });

  // Fetch latest
  const fetchStart = Date.now();
  console.log(`[Worktree] git fetch origin starting for ${repoPath}...`);
  git("fetch origin", repoPath);
  console.log(`[Worktree] git fetch origin completed in ${Date.now() - fetchStart}ms`);

  // Find default branch (dev > master > main)
  let defaultBranch: string;
  for (const candidate of ["dev", "master", "main"]) {
    if (gitSafe(`rev-parse --verify origin/${candidate}`, repoPath)) {
      defaultBranch = candidate;
      break;
    }
  }
  defaultBranch ??= git("symbolic-ref refs/remotes/origin/HEAD", repoPath).replace("refs/remotes/origin/", "");

  // Keep the main repo working directory synced to latest default branch
  const currentBranch = gitSafe("rev-parse --abbrev-ref HEAD", repoPath);
  if (currentBranch === defaultBranch) {
    gitSafe("pull --ff-only origin " + defaultBranch, repoPath);
  } else {
    // Detached or different branch — just update the tracking ref
    gitSafe(`update-ref refs/heads/${defaultBranch} origin/${defaultBranch}`, repoPath);
  }

  const slots: WorktreeSlot[] = [];
  for (let i = 0; i < count; i++) {
    const id = `review-${i}`;
    const wtPath = path.join(poolDir, id);

    if (fs.existsSync(wtPath)) {
      // Reuse existing worktree
    } else {
      git(`worktree add --detach "${wtPath}"`, repoPath);
      git(`checkout origin/${defaultBranch} --detach`, wtPath);
    }

    slots.push({ id, path: wtPath, busy: false });
  }

  return { repoPath, poolDir, slots };
}

function acquireSlot(pool: WorktreePool): WorktreeSlot | null {
  const slot = pool.slots.find((s) => !s.busy);
  if (!slot) return null;
  slot.busy = true;
  return slot;
}

function releaseSlot(pool: WorktreePool, slot: WorktreeSlot): void {
  gitSafe("clean -fd", slot.path);
  const checkout = gitSafe("checkout --detach HEAD", slot.path);
  gitSafe("clean -fd", slot.path);
  if (checkout === null) {
    console.warn(`[Worktree] WARNING: checkout --detach HEAD failed in ${slot.path} during release`);
  }
  slot.busy = false;
}

/** Validate that a string looks like a hex git commit SHA. */
function isValidCommitId(commitId: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(commitId);
}

/** Check if a git object exists locally (instant, no network). */
function hasCommitLocally(commitId: string, cwd: string): boolean {
  if (!isValidCommitId(commitId)) return false;
  return gitSafe(`cat-file -t ${commitId}`, cwd) === "commit";
}

function setupSlotForPR(
  pool: WorktreePool,
  slot: WorktreeSlot,
  sourceBranch: string,
  targetBranch: string,
  latestSourceCommitId: string,
): void {
  if (!isValidCommitId(latestSourceCommitId)) {
    throw new Error(`Invalid commit ID: ${latestSourceCommitId}`);
  }

  console.log(`[Worktree] Setting up ${slot.id} for ${sourceBranch} @ ${latestSourceCommitId.substring(0, 8)}`);

  // Only fetch if the commit isn't already available locally
  // (initWorktreePool does a full fetch at cycle start, so most commits are already here)
  if (hasCommitLocally(latestSourceCommitId, pool.repoPath)) {
    console.log(`[Worktree] Commit ${latestSourceCommitId.substring(0, 8)} already local — skipping fetch`);
  } else {
    console.log(`[Worktree] Commit ${latestSourceCommitId.substring(0, 8)} not local — fetching ${sourceBranch}`);
    git(`fetch origin refs/heads/${sourceBranch}`, pool.repoPath);
    gitSafe(`fetch origin refs/heads/${targetBranch}`, pool.repoPath);
  }

  git("clean -fd", slot.path);
  git(`checkout --detach ${latestSourceCommitId}`, slot.path);
  git("clean -fd", slot.path);
  console.log(`[Worktree] ${slot.id} ready`);
}

// ===========================================================================
// PR state (parameterized per repo)
// ===========================================================================
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

function stateFilePath(repoName: string): string {
  return path.join(__dirname, "..", `pr-state-${repoName}.json`);
}

function loadState(repoName: string): PrState {
  const p = stateFilePath(repoName);
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (Array.isArray(raw.seenPrIds)) {
        const prs: Record<string, string> = {};
        for (const id of raw.seenPrIds) prs[String(id)] = raw.lastChecked || new Date(0).toISOString();
        return { lastChecked: raw.lastChecked, prs };
      }
      // Migrate legacy string entries on load so they don't look "updated" every cycle
      let migrated = false;
      for (const [key, val] of Object.entries(raw.prs ?? {})) {
        if (typeof val === "string") {
          raw.prs[key] = { lastReviewedAt: val, lastSourceCommitId: "legacy-migrated" };
          migrated = true;
        }
      }
      if (migrated) {
        console.log(`[State] Migrated legacy entries in ${repoName} state file`);
        fs.writeFileSync(p, JSON.stringify(raw, null, 2));
      }
      return raw;
    } catch { /* corrupted, start fresh */ }
  }
  return { lastChecked: new Date(0).toISOString(), prs: {} };
}

function saveState(repoName: string, state: PrState): void {
  fs.writeFileSync(stateFilePath(repoName), JSON.stringify(state, null, 2));
}

// ===========================================================================
// PR document builder (same logic, parameterized)
// ===========================================================================
const THREAD_STATUS_MAP: Record<number, string> = {
  0: "unknown", 1: "active", 2: "fixed", 3: "wontFix", 4: "closed", 5: "byDesign", 6: "pending",
};

interface PrThreadComment { commentId: number; author: string; content: string; publishedDate: string; parentCommentId?: number; }
interface PrThread { threadId: number; status: string; filePath?: string; lineNumber?: number; iterationId?: number; iterationSourceCommit?: string; comments: PrThreadComment[]; }
interface PrCommit { commitId: string; author: string; message: string; date: string; }
interface PrIteration { id: number; createdDate: string; sourceCommit: string; targetCommit: string; description?: string; }
interface PrReviewDocument {
  prId: number; title: string; author: string; sourceBranch: string; targetBranch: string;
  baseCommitId: string; latestSourceCommitId: string; latestMergeCommitId: string; createdDate: string;
  iterations: PrIteration[]; commits: PrCommit[]; threads: PrThread[]; updatedThreadsSinceLastCheck: PrThread[];
}

async function buildPrReviewDocument(
  gitApi: IGitApi, repo: string, project: string, prId: number, sinceTimestamp: string | null,
  prData?: any,
): Promise<PrReviewDocument> {
  // Use pre-fetched PR data if available, otherwise fetch (fallback for standalone use)
  const pr = prData ?? await gitApi.getPullRequest(repo, prId, project);
  const title = pr.title ?? "(no title)";
  const author = pr.createdBy?.displayName ?? pr.createdBy?.uniqueName ?? "unknown";
  const sourceBranch = (pr.sourceRefName ?? "").replace("refs/heads/", "");
  const targetBranch = (pr.targetRefName ?? "").replace("refs/heads/", "");
  const baseCommitId = (pr as any).lastMergeTargetCommit?.commitId ?? "";
  const latestSourceCommitId = (pr as any).lastMergeSourceCommit?.commitId ?? "";
  const latestMergeCommitId = (pr as any).lastMergeCommit?.commitId ?? "";
  const createdDate = pr.creationDate ? new Date(pr.creationDate).toISOString() : "";

  const rawIterations = await gitApi.getPullRequestIterations(repo, prId, project);
  const iterations: PrIteration[] = (rawIterations ?? []).map((it: any) => ({
    id: it.id, createdDate: it.createdDate ? new Date(it.createdDate).toISOString() : "",
    sourceCommit: it.sourceRefCommit?.commitId ?? "", targetCommit: it.targetRefCommit?.commitId ?? "",
    description: it.description,
  }));

  const rawCommits = await gitApi.getPullRequestCommits(repo, prId, project);
  const commits: PrCommit[] = (rawCommits ?? []).map((c: any) => ({
    commitId: c.commitId ?? "", author: c.author?.name ?? c.author?.email ?? "unknown",
    message: (c.comment ?? "").trim(), date: c.author?.date ? new Date(c.author.date).toISOString() : "",
  }));

  const iterationCommitMap = new Map<number, string>();
  for (const it of iterations) iterationCommitMap.set(it.id, it.sourceCommit);

  const rawThreads = await gitApi.getThreads(repo, prId, project);
  const allThreads: PrThread[] = [];

  for (const thread of rawThreads ?? []) {
    const threadStatus = THREAD_STATUS_MAP[thread.status ?? 0] ?? "unknown";
    const filePath = thread.threadContext?.filePath ?? undefined;
    const lineNumber = thread.threadContext?.rightFileStart?.line ?? undefined;
    const iterCtx = (thread as any).pullRequestThreadContext?.iterationContext;
    const iterationId = iterCtx?.secondComparingIteration ?? iterCtx?.firstComparingIteration ?? undefined;
    const iterationSourceCommit = iterationId ? iterationCommitMap.get(iterationId) : undefined;

    const comments: PrThreadComment[] = [];
    for (const comment of thread.comments ?? []) {
      if ((comment as any).commentType === 2) continue;
      comments.push({
        commentId: comment.id!, author: comment.author?.displayName ?? comment.author?.uniqueName ?? "unknown",
        content: comment.content ?? "",
        publishedDate: comment.publishedDate ? new Date(comment.publishedDate).toISOString() : "",
        parentCommentId: comment.parentCommentId ?? undefined,
      });
    }
    if (comments.length === 0) continue;
    comments.sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));
    allThreads.push({ threadId: thread.id!, status: threadStatus, filePath, lineNumber, iterationId, iterationSourceCommit, comments });
  }

  allThreads.sort((a, b) => (a.comments[0]?.publishedDate ?? "").localeCompare(b.comments[0]?.publishedDate ?? ""));

  const updatedThreadsSinceLastCheck = sinceTimestamp
    ? allThreads.map((t) => ({ ...t, comments: t.comments.filter((c) => c.publishedDate > sinceTimestamp) })).filter((t) => t.comments.length > 0)
    : allThreads;

  return {
    prId, title, author, sourceBranch, targetBranch, baseCommitId, latestSourceCommitId,
    latestMergeCommitId, createdDate, iterations, commits, threads: allThreads, updatedThreadsSinceLastCheck,
  };
}

// ===========================================================================
// Work item context — pre-fetch hierarchy so Claude agents don't WIQL-query ADO
// ===========================================================================
interface WorkItemNode {
  id: number;
  type: string;
  title: string;
  state: string;
  assignedTo?: string;
  parentId?: number;
  children?: number[];
}

interface WorkItemContext {
  /** Flat map of all fetched work items keyed by ID */
  items: Record<number, WorkItemNode>;
  /** IDs directly linked to the PR */
  linkedIds: number[];
  /** Formatted text for embedding in the review prompt */
  formatted: string;
}

const WORK_ITEM_CONTEXT_CACHE_DIR = path.join(__dirname, "..", "wi-cache");

function workItemCachePath(repoName: string, prId: number): string {
  return path.join(WORK_ITEM_CONTEXT_CACHE_DIR, `${repoName}-pr-${prId}.json`);
}

function loadCachedWorkItemContext(repoName: string, prId: number): WorkItemContext | null {
  const p = workItemCachePath(repoName, prId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveCachedWorkItemContext(repoName: string, prId: number, ctx: WorkItemContext): void {
  if (!fs.existsSync(WORK_ITEM_CONTEXT_CACHE_DIR)) {
    fs.mkdirSync(WORK_ITEM_CONTEXT_CACHE_DIR, { recursive: true });
  }
  fs.writeFileSync(workItemCachePath(repoName, prId), JSON.stringify(ctx, null, 2));
}

/**
 * Fetch work item hierarchy for a PR.
 * Walks: PR → linked work items → parent chain up to Epic.
 * Uses a single batch getWorkItems call with Relations expand, then walks parent links.
 */
async function fetchWorkItemContext(
  gitApi: IGitApi,
  witApi: IWorkItemTrackingApi,
  repo: string,
  project: string,
  prId: number,
): Promise<WorkItemContext> {
  const items: Record<number, WorkItemNode> = {};
  const FIELDS = [
    "System.Id", "System.WorkItemType", "System.Title",
    "System.State", "System.AssignedTo",
  ];

  // 1. Get work item IDs linked to the PR
  const refs = await gitApi.getPullRequestWorkItemRefs(repo, prId, project);
  const linkedIds = (refs ?? []).map((r) => parseInt(r.id!, 10)).filter((id) => !isNaN(id));

  if (linkedIds.length === 0) {
    return { items: {}, linkedIds: [], formatted: "" };
  }

  // 2. Batch-fetch linked work items with relations
  const workItems = await witApi.getWorkItems(linkedIds, FIELDS, undefined, WorkItemExpand.Relations, undefined, project);
  for (const wi of workItems ?? []) {
    if (!wi.id) continue;
    const node = parseWorkItem(wi);
    items[node.id] = node;
  }

  // 3. Walk parent chain (up to 5 levels — Task → Story → Feature → Epic)
  const toFetch = new Set<number>();
  for (const node of Object.values(items)) {
    if (node.parentId && !items[node.parentId]) toFetch.add(node.parentId);
  }

  for (let depth = 0; depth < 5 && toFetch.size > 0; depth++) {
    const batch = Array.from(toFetch);
    toFetch.clear();

    const parents = await witApi.getWorkItems(batch, FIELDS, undefined, WorkItemExpand.Relations, undefined, project);
    for (const wi of parents ?? []) {
      if (!wi.id) continue;
      const node = parseWorkItem(wi);
      items[node.id] = node;
      if (node.parentId && !items[node.parentId]) toFetch.add(node.parentId);
    }
  }

  // 4. Collect sibling IDs from immediate parents (children of the parent)
  const siblingIds = new Set<number>();
  for (const linkedId of linkedIds) {
    const node = items[linkedId];
    if (!node?.parentId || !items[node.parentId]) continue;
    const parent = items[node.parentId];
    for (const childId of parent.children ?? []) {
      if (!items[childId]) siblingIds.add(childId);
    }
  }
  // Batch-fetch siblings (limit to 20)
  const siblingBatch = Array.from(siblingIds).slice(0, 20);
  if (siblingBatch.length > 0) {
    const siblings = await witApi.getWorkItems(siblingBatch, FIELDS, undefined, WorkItemExpand.None, undefined, project);
    for (const wi of siblings ?? []) {
      if (!wi.id) continue;
      items[wi.id] = parseWorkItem(wi);
    }
  }

  // 5. Format the hierarchy
  const formatted = formatWorkItemContext(items, linkedIds);

  return { items, linkedIds, formatted };
}

function parseWorkItem(wi: any): WorkItemNode {
  const fields = wi.fields ?? {};
  const relations = wi.relations ?? [];

  let parentId: number | undefined;
  const children: number[] = [];

  for (const rel of relations) {
    const url: string = rel.url ?? "";
    const idMatch = url.match(/\/workItems\/(\d+)$/);
    if (!idMatch) continue;
    const relId = parseInt(idMatch[1], 10);

    if (rel.rel === "System.LinkTypes.Hierarchy-Reverse") {
      parentId = relId; // parent
    } else if (rel.rel === "System.LinkTypes.Hierarchy-Forward") {
      children.push(relId); // child
    }
  }

  return {
    id: wi.id!,
    type: fields["System.WorkItemType"] ?? "Unknown",
    title: fields["System.Title"] ?? "(no title)",
    state: fields["System.State"] ?? "Unknown",
    assignedTo: fields["System.AssignedTo"]?.displayName ?? fields["System.AssignedTo"] ?? undefined,
    parentId,
    children: children.length > 0 ? children : undefined,
  };
}

function formatWorkItemContext(items: Record<number, WorkItemNode>, linkedIds: number[]): string {
  if (linkedIds.length === 0) return "";

  const lines: string[] = ["## Work Item Context", ""];

  // For each linked work item, show its ancestry chain
  for (const linkedId of linkedIds) {
    const node = items[linkedId];
    if (!node) continue;

    // Build ancestry chain: Epic → Feature → Story → Task
    const chain: WorkItemNode[] = [];
    let current: WorkItemNode | undefined = node;
    const visited = new Set<number>();
    while (current) {
      if (visited.has(current.id)) break;
      visited.add(current.id);
      chain.unshift(current);
      current = current.parentId ? items[current.parentId] : undefined;
    }

    // Render the chain
    for (let i = 0; i < chain.length; i++) {
      const n = chain[i];
      const indent = "  ".repeat(i);
      const marker = n.id === linkedId ? " ← **linked to this PR**" : "";
      lines.push(`${indent}- **${n.type} #${n.id}**: ${n.title} [${n.state}]${marker}`);
    }

    // Show siblings (other children of the immediate parent)
    if (node.parentId && items[node.parentId]) {
      const parent = items[node.parentId];
      const siblingNodes = (parent.children ?? [])
        .filter((id) => id !== linkedId && items[id])
        .map((id) => items[id]);
      if (siblingNodes.length > 0) {
        const sibIndent = "  ".repeat(chain.length - 1);
        lines.push(`${sibIndent}  _Sibling items under ${parent.type} #${parent.id}:_`);
        for (const sib of siblingNodes.slice(0, 10)) {
          lines.push(`${sibIndent}  - ${sib.type} #${sib.id}: ${sib.title} [${sib.state}]`);
        }
        if (siblingNodes.length > 10) {
          lines.push(`${sibIndent}  - _...and ${siblingNodes.length - 10} more_`);
        }
      }
    }

    lines.push("");
  }

  lines.push("**Note:** This work item context is pre-fetched. You do NOT need to query Azure DevOps for work item details.");

  return lines.join("\n");
}

// ===========================================================================
// Prompt builder (same as orchestrate.ts)
// ===========================================================================
function loadPromptFile(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content || content.split("\n").every((l) => l.startsWith("#") || l.startsWith("<!--") || l.trim() === "")) return "";
  return content;
}

function loadCustomPrompt(repoName?: string): string {
  // Global prompt (review-prompt.md)
  const global = loadPromptFile(CUSTOM_PROMPT_FILE);

  // Per-repo prompt (review-prompt-{repoName}.md) — appended after global
  let perRepo = "";
  if (repoName) {
    perRepo = loadPromptFile(path.join(__dirname, "..", `review-prompt-${repoName}.md`));
  }

  return [global, perRepo].filter(Boolean).join("\n\n");
}

function buildReviewPrompt(
  doc: PrReviewDocument, worktreePath: string, docPath: string,
  baseCommitId: string, latestSourceCommitId: string,
  lastReviewedCommitId: string | null, customPrompt: string,
  workItemContext: string = "",
): string {
  const diffFull = `git diff ${baseCommitId}...${latestSourceCommitId}`;
  const diffIncremental = lastReviewedCommitId ? `git diff ${lastReviewedCommitId}...${latestSourceCommitId}` : null;
  const newCommentCount = doc.updatedThreadsSinceLastCheck.reduce((n, t) => n + t.comments.length, 0);

  let diffSection: string;
  if (diffIncremental) {
    diffSection = `## Diff Strategy\nThis is an **incremental review**.\n- **Incremental diff:** \`${diffIncremental}\`\n- **Full diff:** \`${diffFull}\``;
  } else {
    diffSection = `## Diff Strategy\nThis is a **first review**.\n- **Full diff:** \`${diffFull}\``;
  }

  let threadSection = "";
  if (doc.updatedThreadsSinceLastCheck.length > 0) {
    threadSection = `\n## Comment Threads\n**${doc.updatedThreadsSinceLastCheck.length} threads** with **${newCommentCount} new comments** since last review.`;
  }

  const customSection = customPrompt ? `\n## Additional Instructions\n\n${customPrompt}` : "";
  const wiSection = workItemContext ? `\n${workItemContext}` : "";

  return `You are reviewing PR #${doc.prId} in an Azure DevOps repository.

Use the /code-reviewer:pr-review skill to conduct this review. Load the skill first, then follow its process.

## PR Overview
- **Title:** ${doc.title}
- **Author:** ${doc.author}
- **Source branch:** ${doc.sourceBranch}
- **Target branch:** ${doc.targetBranch}
- **Iterations:** ${doc.iterations.length}
- **Commits:** ${doc.commits.length}
- **Comment threads:** ${doc.threads.length}

## Commit IDs
- **Base commit (target branch):** \`${baseCommitId}\`
- **Latest source commit (PR head):** \`${latestSourceCommitId}\`${lastReviewedCommitId ? `\n- **Last reviewed commit:** \`${lastReviewedCommitId}\`` : ""}

## Working Directory
The PR source branch is checked out in this working directory.
${diffSection}
${threadSection}
${wiSection}

## Review Document
\`${docPath}\`
${customSection}

## Your Task
1. Load the /code-reviewer:pr-review skill
2. Read the review document at the path above
3. Run the appropriate diff command(s)
4. Review the code changes thoroughly
5. Check if existing review comments have been addressed
6. Post your findings
`;
}

// ===========================================================================
// Claude runner
// ===========================================================================
function saveSession(record: any): void {
  try { fs.appendFileSync(SESSIONS_FILE, JSON.stringify(record) + "\n"); } catch { /* best effort */ }
}

function runClaude(
  prompt: string, cwd: string, prId: number, repo: RepoConfig,
): Promise<{ exitCode: number; output: string; sessionId: string }> {
  const sessionId = randomUUID();

  return new Promise((resolve) => {
    log(repo.name, `[Claude] Spawning review for PR #${prId} | Session: ${sessionId}`);

    saveSession({ sessionId, prId, repo: repo.repository, worktreePath: cwd, startedAt: new Date().toISOString() });

    const env = { ...process.env };
    delete env.CLAUDECODE;

    // MCP config file (resolved from template)
    const mcpConfigPath = writeMcpConfig(".mcp-review.json", repo);

    const child = spawn("claude", [
      "-p", "--dangerously-skip-permissions", "--model", "opus",
      "--session-id", sessionId,
      "--mcp-config", mcpConfigPath, "--",
      "-",
    ], { cwd, stdio: ["pipe", "pipe", "pipe"], env, shell: true });

    child.stdin!.write(prompt);
    child.stdin!.end();

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      logErr(repo.name, `[Claude] PR #${prId} timed out after ${REVIEW_TIMEOUT_MS / 60000} min, killing.`);
      child.kill();
    }, REVIEW_TIMEOUT_MS);

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      for (const line of text.split("\n").filter((l: string) => l.trim())) {
        log(repo.name, `  [PR#${prId}] ${line}`);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

      if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const resultPath = path.join(RESULTS_DIR, `review-${prId}-${Date.now()}.md`);
      fs.writeFileSync(resultPath, output);

      const suffix = killed ? " (timed out)" : "";
      log(repo.name, `[Claude] PR #${prId} review complete (exit ${code})${suffix}. Saved to ${resultPath}`);

      saveSession({
        sessionId, prId, repo: repo.repository, worktreePath: cwd,
        startedAt: "", completedAt: new Date().toISOString(),
        exitCode: killed ? 1 : (code ?? 1), reviewResultPath: resultPath,
      });

      resolve({ exitCode: killed ? 1 : (code ?? 1), output, sessionId });
    });
  });
}

// ===========================================================================
// Review Job — what gets pushed into the queue
// ===========================================================================
interface ReviewJob {
  prId: number;
  sinceTimestamp: string | null;
  sourceCommitId: string;
  prData?: any;  // Pre-fetched PR object from list response — avoids redundant getPullRequest
}

// ===========================================================================
// Per-repo pipeline
// ===========================================================================
class RepoPipeline {
  private repo: RepoConfig;
  private pool: WorktreePool;
  private queue: ReviewJob[] = [];
  private state: PrState;
  private customPrompt: string;
  private gitApi: IGitApi | null = null;
  private witApi: IWorkItemTrackingApi | null = null;
  private workerCount: number;
  private running = false;
  private wakeWorkers: (() => void)[] = [];
  private maxPerRepo: number;  // 0 = unlimited

  // Stats
  public succeeded = 0;
  public failed = 0;

  constructor(repo: RepoConfig, customPrompt: string, maxPerRepo: number = 0) {
    this.repo = repo;
    this.customPrompt = customPrompt;
    this.workerCount = repo.worktreeCount;
    this.maxPerRepo = maxPerRepo;
    this.state = loadState(repo.repository);

    // Initialize worktree pool
    log(repo.name, "Initializing worktree pool...");
    this.pool = initWorktreePool(repo.localPath, repo.worktreeCount);
    log(repo.name, `Pool ready: ${this.pool.slots.length} worktree(s).`);
  }

  async init(connection: azdev.WebApi): Promise<void> {
    this.gitApi = await connection.getGitApi();
    this.witApi = await connection.getWorkItemTrackingApi();
  }

  // --- Watcher: discover PRs and push to queue ---
  async watch(): Promise<void> {
    if (!this.gitApi) throw new Error("Not initialized — call init() first");

    log(this.repo.name, "[Watch] Scanning for PRs...");
    logActivity({ timestamp: new Date().toISOString(), repo: this.repo.name, event: "cycle_start" });

    const searchCriteria = { status: 1 } as any;
    const apiStart = Date.now();
    log(this.repo.name, "[Watch] Calling getPullRequests...");
    const pullRequests = await this.gitApi.getPullRequests(
      this.repo.repository, searchCriteria, this.repo.project, undefined, 0, 200,
    );
    const apiMs = Date.now() - apiStart;
    const activePRs = (pullRequests ?? []).filter((pr) => !pr.isDraft);
    log(this.repo.name, `[Watch] getPullRequests returned ${(pullRequests ?? []).length} PRs (${activePRs.length} active non-draft) in ${apiMs}ms`);

    const now = Date.now();
    let enqueued = 0;
    let idleSkipped = 0;

    for (const pr of activePRs) {
      // Stop enqueuing if we've hit the per-repo limit
      if (this.maxPerRepo > 0 && enqueued >= this.maxPerRepo) break;

      const prId = pr.pullRequestId!;
      const key = String(prId);

      if (isPrIdle(pr, now)) {
        idleSkipped++;
        log(
          this.repo.name,
          `[IDLE] PR #${prId} — no source activity for ${formatPrIdleAge(pr, now)}; ` +
          `skipping PRs idle over ${PR_IDLE_THRESHOLD_HOURS}h`,
        );
        continue;
      }

      const previousRaw = this.state.prs[key];

      const previous = previousRaw ? parsePrEntry(previousRaw) : null;
      const decision = getPrReviewDecision(pr, previous, now);

      if (decision.kind === "wait") {
        log(this.repo.name, `[DEFER] PR #${prId} — ${formatPrReviewWait(decision)}`);
        continue;
      }

      if (decision.kind === "ignore") {
        continue;
      }

      this.enqueue({
        prId,
        sinceTimestamp: decision.sinceTimestamp,
        sourceCommitId: decision.latestSourceCommitId,
        prData: pr,
      });
      enqueued++;
    }

    // Clean up PRs no longer active (state + work item cache)
    const activeIds = new Set(activePRs.map((pr) => String(pr.pullRequestId!)));
    for (const key of Object.keys(this.state.prs)) {
      if (!activeIds.has(key)) {
        delete this.state.prs[key];
        try { fs.unlinkSync(workItemCachePath(this.repo.repository, parseInt(key))); } catch { /* file may not exist */ }
      }
    }
    this.state.lastChecked = new Date().toISOString();
    saveState(this.repo.repository, this.state);

    const watchMs = Date.now() - apiStart;
    log(
      this.repo.name,
      `[Watch] Scan complete in ${watchMs}ms — enqueued ${enqueued} PR(s), ` +
      `skipped ${idleSkipped} idle PR(s), queue depth: ${this.queue.length}`,
    );
  }

  private enqueue(job: ReviewJob): void {
    // Don't enqueue duplicates
    if (this.queue.some((j) => j.prId === job.prId)) return;
    this.queue.push(job);
    log(this.repo.name, `[Queue] Enqueued PR #${job.prId} | queue=${this.queue.length} sleepingWorkers=${this.wakeWorkers.length}`);

    // Wake a sleeping worker if any
    const wake = this.wakeWorkers.shift();
    if (wake) {
      log(this.repo.name, `[Queue] Woke a sleeping worker for PR #${job.prId}`);
      wake();
    }
  }

  private dequeue(): ReviewJob | null {
    return this.queue.shift() ?? null;
  }

  // --- Wait until a job is available (always waits for explicit wake signal) ---
  private waitForJob(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeWorkers.push(resolve);
    });
  }

  // --- Worker loop: pull job, review, release, repeat ---
  private async workerLoop(workerId: number): Promise<void> {
    const slot = this.pool.slots[workerId];
    const tag = `${this.repo.name}:W${workerId}`;

    while (this.running) {
      // If queue is empty, wait for a wake signal; otherwise dequeue immediately
      if (this.queue.length === 0) {
        log(tag, `[Worker] Sleeping — queue empty, waiting for wake signal`);
        await this.waitForJob();
        if (!this.running) {
          log(tag, `[Worker] Woke but running=false, exiting`);
          break;
        }
        log(tag, `[Worker] Woke — queue=${this.queue.length}`);
      }

      const job = this.dequeue();
      if (!job) {
        log(tag, `[Worker] Dequeue returned null (race with another worker), looping`);
        continue;
      }

      // Mark slot busy IMMEDIATELY after dequeue — before any async work —
      // so the drain check never sees queue=0 + busyCount=0 while a worker
      // is between dequeue and the first await.
      slot.busy = true;

      const startTime = Date.now();
      log(tag, `Picked up PR #${job.prId} | queue=${this.queue.length} busy=${this.pool.slots.filter(s => s.busy).length}`);

      logActivity({
        timestamp: new Date().toISOString(), repo: this.repo.name,
        event: "review_start", prId: job.prId,
      });

      try {
        // Build PR document (pass pre-fetched PR data to avoid redundant getPullRequest call)
        let stepStart = Date.now();
        log(tag, `[Step] buildPrReviewDocument starting for PR #${job.prId}...`);
        const doc = await buildPrReviewDocument(
          this.gitApi!, this.repo.repository, this.repo.project, job.prId, job.sinceTimestamp,
          job.prData,
        );
        log(tag, `[Step] buildPrReviewDocument completed in ${Date.now() - stepStart}ms (${doc.threads.length} threads, ${doc.commits.length} commits)`);

        // Save document
        const docsDir = path.join(__dirname, "..", "pr-docs", this.repo.repository);
        if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
        const docPath = path.join(docsDir, `pr-${doc.prId}.json`);
        fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));

        // Find last-reviewed commit
        let lastReviewedCommitId: string | null = null;
        if (job.sinceTimestamp && doc.iterations.length > 0) {
          const prev = doc.iterations.filter((it) => it.createdDate <= job.sinceTimestamp!);
          if (prev.length > 0) lastReviewedCommitId = prev[prev.length - 1].sourceCommit;
        }

        // Fetch work item context (use cache on re-reviews to avoid WIQL queries)
        stepStart = Date.now();
        let wiContext: WorkItemContext | null = null;
        if (job.sinceTimestamp) {
          // Re-review — try cache first
          wiContext = loadCachedWorkItemContext(this.repo.repository, job.prId);
          if (wiContext) {
            log(tag, `PR #${job.prId} — work item context loaded from cache (${wiContext.linkedIds.length} items)`);
          }
        }
        if (!wiContext && this.witApi) {
          try {
            log(tag, `[Step] fetchWorkItemContext starting for PR #${job.prId}...`);
            wiContext = await fetchWorkItemContext(
              this.gitApi!, this.witApi, this.repo.repository, this.repo.project, job.prId,
            );
            log(tag, `[Step] fetchWorkItemContext completed in ${Date.now() - stepStart}ms (${wiContext.linkedIds.length} linked items)`);
            if (wiContext.linkedIds.length > 0) {
              saveCachedWorkItemContext(this.repo.repository, job.prId, wiContext);
              log(tag, `PR #${job.prId} — cached work item context`);
            }
          } catch (err: any) {
            log(tag, `PR #${job.prId} — work item context fetch failed: ${err.message} (continuing without)`);
          }
        }

        // Setup worktree
        stepStart = Date.now();
        log(tag, `[Step] setupSlotForPR starting...`);
        setupSlotForPR(this.pool, slot, doc.sourceBranch, doc.targetBranch, doc.latestSourceCommitId);
        log(tag, `[Step] setupSlotForPR completed in ${Date.now() - stepStart}ms`);

        // Build prompt
        const prompt = buildReviewPrompt(
          doc, slot.path, docPath, doc.baseCommitId, doc.latestSourceCommitId,
          lastReviewedCommitId, this.customPrompt, wiContext?.formatted ?? "",
        );

        // Save prompt for debugging
        if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
        fs.writeFileSync(path.join(RESULTS_DIR, `prompt-${job.prId}.md`), prompt);

        // Run Claude
        const result = await runClaude(prompt, slot.path, job.prId, this.repo);
        const duration = Date.now() - startTime;

        // Update state transactionally
        if (result.exitCode === 0 && result.output.length >= MIN_REVIEW_LENGTH) {
          this.state.prs[String(job.prId)] = {
            lastReviewedAt: new Date().toISOString(),
            lastSourceCommitId: job.sourceCommitId,
          };
          saveState(this.repo.repository, this.state);
          log(tag, `PR #${job.prId} — review verified (${result.output.length} chars), state updated. [${Math.round(duration / 1000)}s]`);
          this.succeeded++;

          logActivity({
            timestamp: new Date().toISOString(), repo: this.repo.name,
            event: "review_complete", prId: job.prId, duration,
          });
        } else {
          const reason = result.exitCode !== 0
            ? `exit code ${result.exitCode}`
            : `output too short (${result.output.length} chars)`;
          log(tag, `PR #${job.prId} — ${reason}, will retry. [${Math.round(duration / 1000)}s]`);
          this.failed++;

          logActivity({
            timestamp: new Date().toISOString(), repo: this.repo.name,
            event: "review_failed", prId: job.prId, details: reason, duration,
          });
        }
      } catch (err: any) {
        logErr(tag, `PR #${job.prId} error: ${err.message}`);
        this.failed++;

        // Permanent errors (auth, not found, deleted branch) — update state so we don't retry forever
        const errMsg = err.message ?? "";
        const isPermanent = /TF400813|TF401019|does not exist|is not authorized|couldn't find remote ref/.test(errMsg);
        if (isPermanent) {
          log(tag, `PR #${job.prId} — permanent error, marking as reviewed to stop retries`);
          this.state.prs[String(job.prId)] = {
            lastReviewedAt: new Date().toISOString(),
            lastSourceCommitId: job.sourceCommitId || "permanent-error",
          };
          saveState(this.repo.repository, this.state);
        }

        logActivity({
          timestamp: new Date().toISOString(), repo: this.repo.name,
          event: "review_failed", prId: job.prId, details: `${isPermanent ? "[PERMANENT] " : ""}${errMsg.substring(0, 200)}`,
        });
      } finally {
        // Always release the slot
        log(tag, `[Worker] Releasing slot — queue=${this.queue.length} busy=${this.pool.slots.filter(s => s.busy).length}`);
        releaseSlot(this.pool, slot);
        log(tag, `[Worker] Slot released — queue=${this.queue.length} busy=${this.pool.slots.filter(s => s.busy).length}`);
      }
    }

    log(tag, `[Worker] Exited loop — running=${this.running} queue=${this.queue.length}`);
  }

  // --- Start N workers, run watcher, then wait for queue to drain ---
  async runOnce(): Promise<void> {
    this.running = true;
    log(this.repo.name, `[Cycle] runOnce() started — workers=${this.workerCount}`);

    // Discover PRs
    await this.watch();

    if (this.queue.length === 0) {
      log(this.repo.name, "No PRs to review.");
      logActivity({
        timestamp: new Date().toISOString(), repo: this.repo.name,
        event: "cycle_end", details: "0 succeeded, 0 failed",
      });
      return;
    }

    log(this.repo.name, `[Cycle] Starting ${this.workerCount} worker(s) for ${this.queue.length} job(s)`);

    // Start workers — they'll pull from the queue and stop when it's empty
    const workerPromises: Promise<void>[] = [];
    for (let i = 0; i < this.workerCount; i++) {
      workerPromises.push(this.workerLoop(i));
    }

    // Wake workers with a stagger so we don't launch all reviews simultaneously.
    // First worker starts immediately; each subsequent one waits WARMUP_STAGGER_MS.
    const wakeCount = Math.min(this.queue.length, this.workerCount);
    for (let i = 0; i < wakeCount; i++) {
      const delay = i * WARMUP_STAGGER_MS;
      setTimeout(() => {
        if (!this.running) return;
        log(this.repo.name, i === 0
          ? `Starting review 1/${wakeCount}...`
          : `Warmup: starting review ${i + 1}/${wakeCount} (after ${delay / 1000}s stagger)...`);
        const wake = this.wakeWorkers.shift();
        if (wake) {
          wake();
        } else {
          log(this.repo.name, `[Cycle] WARNING: stagger wake ${i + 1} found no sleeping worker`);
        }
      }, delay);
    }

    // Wait for the queue to drain (workers will block on waitForJob)
    // Poll until queue is empty and no workers are busy
    let drainCheckCount = 0;
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const busyCount = this.pool.slots.filter((s) => s.busy).length;
        drainCheckCount++;
        // Log every 30th check (~60s) so we know the drain poll is alive
        if (drainCheckCount % 30 === 0) {
          log(this.repo.name, `[Drain] Still waiting — queue=${this.queue.length} busy=${busyCount} sleepingWorkers=${this.wakeWorkers.length} (check #${drainCheckCount})`);
        }
        if (this.queue.length === 0 && busyCount === 0) {
          log(this.repo.name, `[Drain] Queue drained — queue=0 busy=0 after ${drainCheckCount} checks`);
          clearInterval(check);
          this.running = false;
          // Wake any sleeping workers so they exit
          const sleepingCount = this.wakeWorkers.length;
          for (const wake of this.wakeWorkers) wake();
          this.wakeWorkers = [];
          log(this.repo.name, `[Drain] Woke ${sleepingCount} sleeping worker(s), set running=false`);
          resolve();
        }
      }, 2000);
    });

    log(this.repo.name, `[Cycle] Drain complete, waiting for worker promises to resolve...`);
    await Promise.all(workerPromises);

    log(this.repo.name, `[Cycle] runOnce() complete — ${this.succeeded} succeeded, ${this.failed} failed`);

    logActivity({
      timestamp: new Date().toISOString(), repo: this.repo.name,
      event: "cycle_end", details: `${this.succeeded} succeeded, ${this.failed} failed`,
    });
  }
}

// ===========================================================================
// Dashboard
// ===========================================================================
function printDashboard(): void {
  if (!fs.existsSync(ACTIVITY_LOG)) { console.log("No activity yet."); return; }

  const lines = fs.readFileSync(ACTIVITY_LOG, "utf-8").trim().split("\n");
  const entries: ActivityEntry[] = lines.filter(Boolean).map((l) => JSON.parse(l));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = entries.filter((e) => e.timestamp >= since);

  const reviews = recent.filter((e) => e.event === "review_complete");
  const errors = recent.filter((e) => e.event === "error" || e.event === "review_failed");
  const cycles = recent.filter((e) => e.event === "cycle_end");
  const repos = new Set(recent.map((e) => e.repo));

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║              Revobot Dashboard (last 24h)               ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  Cycles completed:  ${String(cycles.length).padEnd(37)}║`);
  console.log(`║  Reviews completed: ${String(reviews.length).padEnd(37)}║`);
  console.log(`║  Errors:            ${String(errors.length).padEnd(37)}║`);
  console.log(`║  Repos active:      ${String(repos.size).padEnd(37)}║`);
  console.log("╠══════════════════════════════════════════════════════════╣");

  for (const repo of repos) {
    const repoReviews = reviews.filter((e) => e.repo === repo);
    const repoErrors = errors.filter((e) => e.repo === repo);
    console.log(`║  ${repo.padEnd(56)}║`);
    console.log(`║    Reviews: ${String(repoReviews.length).padEnd(6)} Errors: ${String(repoErrors.length).padEnd(29)}║`);
    for (const r of repoReviews.slice(-5)) {
      const prStr = `PR #${r.prId}`;
      const durStr = r.duration ? `${Math.round(r.duration / 1000)}s` : "";
      console.log(`║    ${prStr.padEnd(20)} ${durStr.padEnd(32)}║`);
    }
  }

  console.log("╚══════════════════════════════════════════════════════════╝\n");
}

// ===========================================================================
// Main — daemon loop or single cycle
// ===========================================================================
async function daemonLoop(maxPerRepo: number = 0): Promise<void> {
  const repos: RepoConfig[] = JSON.parse(fs.readFileSync(REPOS_CONFIG, "utf-8"));
  const enabled = repos.filter((r) => r.enabled);

  if (enabled.length === 0) { console.error("No enabled repos in repos.json"); process.exit(1); }

  console.log(`\n[Daemon] Starting with ${enabled.length} repo(s), polling every ${POLL_INTERVAL_MS / 60000} min`);
  console.log(`[Daemon] Repos: ${enabled.map((r) => `${r.name} (${r.worktreeCount}W)`).join(", ")}`);
  if (maxPerRepo > 0) console.log(`[Daemon] Limit: ${maxPerRepo} PR(s) per repo per cycle`);

  // Shared connection (same org for all repos)
  const connection = await createConnection(enabled[0].orgUrl);

  // Create pipelines (each gets global + per-repo prompt)
  const pipelines: RepoPipeline[] = [];
  for (const repo of enabled) {
    const customPrompt = loadCustomPrompt(repo.name);
    const pipeline = new RepoPipeline(repo, customPrompt, maxPerRepo);
    await pipeline.init(connection);
    pipelines.push(pipeline);
  }

  // Graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n[Daemon] Shutting down after current cycle completes...");
  });
  process.on("SIGTERM", () => { stopping = true; });

  while (!stopping) {
    const cycleStart = Date.now();
    console.log(`\n${"=".repeat(60)}`);
    console.log(`[Daemon] Cycle starting at ${new Date().toISOString()}`);
    console.log(`${"=".repeat(60)}\n`);

    // Run all pipelines in parallel — each pipeline manages its own workers
    console.log(`[Daemon] Launching ${pipelines.length} pipeline(s) in parallel...`);
    await Promise.all(pipelines.map((p, i) => p.runOnce().then(() => {
      console.log(`[Daemon] Pipeline ${i} (${enabled[i].name}) finished runOnce()`);
    }).catch((err) => {
      logErr("Daemon", `Pipeline ${enabled[i].name} error: ${err.message}\n${err.stack}`);
    })));

    const cycleDuration = Math.round((Date.now() - cycleStart) / 1000);
    const totalSucceeded = pipelines.reduce((n, p) => n + p.succeeded, 0);
    const totalFailed = pipelines.reduce((n, p) => n + p.failed, 0);

    console.log(`\n[Daemon] All pipelines done. Cycle complete in ${cycleDuration}s: ${totalSucceeded} reviews, ${totalFailed} failed`);
    printDashboard();

    // Reset stats for next cycle
    for (const p of pipelines) { p.succeeded = 0; p.failed = 0; }

    if (stopping) break;

    console.log(`[Daemon] Next cycle in ${POLL_INTERVAL_MS / 60000} minutes...`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      const checkStop = setInterval(() => {
        if (stopping) { clearTimeout(timer); clearInterval(checkStop); resolve(); }
      }, 1000);
      timer.unref?.();
    });
  }

  console.log("[Daemon] Stopped.");
}

async function runOnce(maxPerRepo: number = 0): Promise<void> {
  const repos: RepoConfig[] = JSON.parse(fs.readFileSync(REPOS_CONFIG, "utf-8"));
  const enabled = repos.filter((r) => r.enabled);

  if (enabled.length === 0) { console.error("No enabled repos in repos.json"); process.exit(1); }

  if (maxPerRepo > 0) {
    console.log(`[Daemon] Limit: ${maxPerRepo} PR(s) per repo`);
  }

  const connection = await createConnection(enabled[0].orgUrl);

  const pipelines: RepoPipeline[] = [];
  for (const repo of enabled) {
    const customPrompt = loadCustomPrompt(repo.name);
    const pipeline = new RepoPipeline(repo, customPrompt, maxPerRepo);
    await pipeline.init(connection);
    pipelines.push(pipeline);
  }

  await Promise.all(pipelines.map((p) => p.runOnce().catch((err) => {
    logErr("Daemon", `Pipeline error: ${err.message}`);
  })));

  printDashboard();
}

// ===========================================================================
// CLI
// ===========================================================================
const command = process.argv[2];
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 0;

if (command === "dashboard") {
  printDashboard();
} else if (command === "once") {
  runOnce(limit).catch((err) => { console.error("Fatal:", err); process.exit(1); });
} else {
  daemonLoop(limit).catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
