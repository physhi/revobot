# Plan: Autonomous Developer Daemon (`dev-daemon.ts`)

A new long-running daemon acting as an autonomous developer: discovers assigned work items, waits for natural-language approval in WI comments (no Claude — pure keyword scan), implements via Claude + ADO skills in per-WI worktrees, self-reviews twice, publishes PRs, then babysits until merged — with smart change-detection to avoid unnecessary Claude invocations.

Two cross-cutting concerns apply to every Claude invocation in this daemon:
1. **Session memory**: After every Claude session completes, the daemon makes a second lightweight "summarize" call asking Claude to write a compressed context file. The next session reads this file to resume with full context without re-discovering everything.
2. **HITL**: Every prompt instructs Claude to use the `mcp__hitl__AskUserQuestion` tool whenever it needs human input, rather than blocking or guessing.

---

## State Machine

```
discovered
  → needs_plan        (Claude posts plan to WI via work-on Phase 1)
  → plan_approved     (keyword scan detects "go ahead", "approved", "rock 'n roll", etc.)
  → implementing      (Claude implements + self-reviews x2 + publishes PR)
  → pr_babysitting    (polling PR for changes)
  → completed         (PR merged — worktree cleaned up)
  → abandoned         (3 failures or permanent error — worktree kept)
```

**Critical insight on `work-on` 2 phases**: The existing `ado:work-on` skill is already 2-phase — Phase 1 posts a design plan to WI comments for review, Phase 2 executes it. The daemon's state machine maps directly to this: `needs_plan` = Phase 1 invocation, `plan_approved` = approval keyword detected, `implementing` = Phase 2 invocation.

**Approval detection is keyword-only in daemon** (zero Claude): scan new WI comments for "approved", "go ahead", "let's", "proceed", "implement", "rock", "lgtm", "ship it" — configurable via `APPROVAL_KEYWORDS` env var.

---

## State File: `dev-state-{repoName}.json`

```typescript
interface DevStateFile {
  version: 1;
  lastDiscoveryAt: string | null;
  items: Record<string, DevWorkItemState>; // key = workItemId as string
}

interface DevWorkItemState {
  workItemId: number;
  title: string;
  state: DevLifecycleState;
  discoveredAt: string;
  updatedAt: string;

  // Approval detection
  lastWiCommentCount: number;          // skip re-scan if unchanged
  lastWiCommentCheckedAt: string | null;
  approvalCommentText: string | null;  // snippet of approving comment (audit)
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
  backoffUntil: string | null;         // 5m → 10m → abandon

  // Session tracking (per phase — enables --session-id resume)
  planSessionId: string | null;        // Phase 1 session — reused on plan retries
  implSessionId: string | null;        // Phase 2 session — reused on impl retries
  babysitSessionId: string | null;     // Babysit session — reused across babysit cycles
  babysitSessionTurnCount: number;     // tracks how many turns in current babysit session

  // PR tracking
  pullRequestId: number | null;
  pullRequestUrl: string | null;
  pullRequestStatus: "active" | "completed" | "abandoned" | null;

  // PR change detection (babysit gating)
  lastPrThreadCount: number;
  lastPrCommentCount: number;
  lastPrLatestActivityAt: string | null;
  lastBuildResultId: string | null;    // "{buildId}:{status}:{result}"
  lastBuildStatus: string | null;
  lastTestSummaryHash: string | null;

  // Babysit scheduling
  lastBabysitCheckAt: string | null;
  lastBabysitClaudeAt: string | null;
  babysitInvocations: number;
  babysitStartedAt: string | null;     // for 72h timeout
}
```

---

## Phase 1 — Foundation & Config

1. Create `src/dev-daemon.ts` — new standalone file (NOT merged into daemon.ts)
2. Create `src/dev-state.ts` — `DevWorkItemState` type + `loadDevState(repoName)` / `saveDevState(repoName, state)` helpers
3. Create `src/dev-prompts.ts` — all 3 prompt builders + `parseResultBlock()`
4. Add 7 new env vars to `.env`:
   - `MAX_WIP_ITEMS` default 2 — global WIP limit across all repos
   - `BABYSIT_INTERVAL_MINUTES` default 15
   - `BABYSIT_TIMEOUT_HOURS` default 72
   - `BABYSIT_MAX_INVOCATIONS` default 20
   - `DEVELOPER_UPN` required — for WIQL "Assigned To" filter
   - `DEV_WORKTREE_BASE` required — base path for per-WI worktrees
   - `APPROVAL_KEYWORDS` optional — comma-separated, default: "approved,go ahead,let's,proceed,implement,rock,lgtm,ship it,do it,yes,confirmed"
   - `IMPLEMENTATION_MAX_ATTEMPTS` default 3
5. Add to `package.json` scripts: `dev-daemon` (loop), `dev-daemon:once`, `dev-daemon:dashboard`
   - *Steps 1–5 parallel*

---

## Phase 2 — Per-WI Worktree Management

6. Implement `ensureWorkItemWorktree(repoPath, workItemId, repoName)`:
   - Path: `{DEV_WORKTREE_BASE}/{repoName}/wi-{workItemId}`
   - If missing: `git worktree add --detach {path}` + `git checkout origin/{defaultBranch} --detach`
   - If exists + clean: reuse as-is
   - If exists + dirty: `git clean -fd && git checkout --detach HEAD`
   - If corrupt: remove and recreate; capture HEAD before removal
   - Returns `{ worktreePath, baseBranch, worktreeStatus }`
   - Uses `git()` / `gitSafe()` helpers verbatim from `daemon.ts`
7. Implement `cleanupWorkItemWorktree(worktreePath, repoPath)`:
   - Only called on `completed` state transition
   - `git worktree remove --force {path}`
   - On `abandoned`: keep worktree for forensic/manual recovery
   - *Depends on step 6*

---

## Phase 3 — Smart Change Detection

8. Implement `scanWiApproval(witApi, workItemId, lastCommentCount, approvalKeywords)`:
   - Calls `witApi.getComments(workItemId)` — cheap single API call
   - If `comments.totalCount === lastCommentCount`: return `{ changed: false }` immediately (no scan)
   - If changed: scan new comments for any `approvalKeywords` match (case-insensitive)
   - Returns `{ changed: true, approved: bool, newCommentCount, approvalSnippet }`
   - **No Claude. Pure string matching in daemon process.**
9. Implement `checkPrChanged(gitApi, repoName, project, prId, state)`:
   - Call `gitApi.getPullRequest(repoName, prId, project)` — cheap
   - Call `gitApi.getThreads(repoName, prId, project)` — cheap
   - Call latest build query for branch (top=1) — cheap
   - Compare against `state.lastPrThreadCount`, `state.lastPrCommentCount`, `state.lastBuildResultId`
   - Also check `PR.status` for completion/abandonment
   - Returns `{ prStatus, threadChanged, buildChanged, newThreadCount, newCommentCount, newBuildResultId, latestActivityAt }`
   - *Parallel with step 8*
10. Implement `shouldInvokeBabysit(state, checkResult, now)`:
    - Returns `false` if `now < lastBabysitCheckAt + BABYSIT_INTERVAL_MS`
    - Returns `false` if `babysitInvocations >= BABYSIT_MAX_INVOCATIONS`
    - Returns `false` if `now > babysitStartedAt + 72h`
    - Returns `false` if `!checkResult.threadChanged && !checkResult.buildChanged`
    - Returns `true` only if interval passed AND something actually changed
    - *Depends on step 9*

---

## Phase 3b — Session Memory System

### Concept
After every Claude session ends (plan, implementation, or babysit), the daemon makes one more lightweight Claude invocation — a "compress and save" call. Claude reads its own prior output + any existing context file and writes a compact `wi-{id}-context.md` to the WI scratchpad. The next session for this WI always loads this file first, giving Claude instant continuity without re-discovering everything from scratch.

### Context file location
`{DEV_WORKTREE_BASE}/.scratchpad/wi-{workItemId}/context.md`

Kept alongside any other scratchpad artifacts (comments, plans) the agent already writes. Survives daemon restarts. Overwritten (not appended) each session — always reflects latest state.

### Context file schema (compressed, target < 150 lines)
```
# WI {id} — {title}
## Status
- Current state: {lifecycleState}
- PR: #{prId} ({prStatus})
- Last session: {ISO timestamp}
- Next step: {one sentence — what to do next}

## What was done
- {Bullet per meaningful action this session}

## Implementation decisions
- {Key design choices made, with brief rationale}

## Open questions / blockers
- {Anything unresolved that may need user input — use HITL}

## Unresolved reviewer comments
- {Thread id + comment snippet + status: open/addressed/deferred}

## Important file paths
- {Any non-obvious files touched or created}

## Learnings
- {Anything non-obvious discovered about the codebase, ADO config, CI behavior, etc.}
```

### Summarize prompt (`buildSummarizePrompt`)
Implement `buildSummarizePrompt(workItemId, worktreePath, priorOutput, existingContext)` in `dev-prompts.ts`:
- Passes the Claude session output from the prior invocation
- Passes the existing `context.md` content (if any)
- Instructs Claude to: merge old context + new session output into a freshly compressed `context.md`. Overwrite the file. Be ruthlessly concise — compress, don't dump.
- Explicitly: "Do NOT take any development actions. Only read and write the context file."
- Short timeout: 5 minutes (not 30)
- Result block:
  ```
  === DEV_DAEMON_RESULT ===
  status: saved|failed
  context_path: <path>
  === END DEV_DAEMON_RESULT ===
  ```

### When to invoke summarize
- After **every** Claude session completion (plan, implementation, babysit) — regardless of exit code
- On failure: Claude still writes what it attempted, what broke, and what to try next
- The daemon calls `runClaude(summarizePrompt, worktreePath, workItemId, repo, { timeoutMs: 5*60*1000 })` immediately after the primary invocation completes

### How context is consumed
- Every primary prompt (plan, implementation, babysit) starts with: "Your previous session context for this work item is at `{worktreePath}/../../.scratchpad/wi-{id}/context.md`. Read it first."
- Add `contextPath` to `DevWorkItemState.contextFilePath` (new field)
- Daemon checks file exists before including path in prompt

### State field addition
Add to `DevWorkItemState`:
```typescript
contextFilePath: string | null;       // path to context.md once first session completes
lastContextWrittenAt: string | null;
```

---

## Phase 4 — Prompt Builders (`dev-prompts.ts`)

11. Implement `buildPlanPrompt(workItem, worktreePath, repoContext, customPrompt, contextFilePath)`:
    - First line of prompt: if `contextFilePath` exists — "Read your previous context first: `{contextFilePath}`"
    - Instructs Claude to load `ado:work-on` skill
    - Explicitly says: "This is Phase 1 — post a plan to the work item comments for developer approval. Do NOT implement yet."
    - Includes per-repo custom prompt from `dev-prompt-{repoName}.md` if present
    - **HITL instruction** (mandatory in all prompts): "If you need to ask the user a question, get clarification, or request a decision at any point, use the `mcp__hitl__AskUserQuestion` MCP tool. Do not block, do not guess — ask via HITL."
    - Result block contract:
      ```
      === DEV_DAEMON_RESULT ===
      status: plan_posted|blocked|failed
      work_item_id: {id}
      plan_comment_id: <id or empty>
      summary: <one-line>
      === END DEV_DAEMON_RESULT ===
      ```
12. Implement `buildImplementationPrompt(workItem, worktreePath, planCommentId, repoContext, customPrompt, contextFilePath)`:
    - First line: read context file if present
    - Instructs Claude to load `ado:work-on` skill
    - Explicitly says: "This is Phase 2 — the plan has been approved. Implement the approved plan."
    - After implementation: "Load `code-reviewer:pr-review` and self-review. Apply fixes. Repeat one more time (2 total). Then publish PR."
    - **HITL instruction**: same as above — mandatory in every prompt
    - Result block contract:
      ```
      === DEV_DAEMON_RESULT ===
      status: success|blocked|failed
      work_item_id: {id}
      branch_name: <branch>
      pull_request_id: <number or empty>
      pull_request_url: <url or empty>
      head_commit_id: <sha or empty>
      review_iterations_completed: <0|1|2>
      summary: <one-line>
      === END DEV_DAEMON_RESULT ===
      ```
13. Implement `buildBabysitPrompt(workItem, prId, worktreePath, changeContext, repoContext, contextFilePath)`:
    - First line: read context file if present
    - Instructs Claude to load `ado:babysit-pr` skill
    - Describes exactly what changed (thread delta, build status change, test summary change)
    - "Address what changed. Do NOT re-implement. Do NOT create a new PR."
    - **HITL instruction**: same — mandatory
    - Result block contract:
      ```
      === DEV_DAEMON_RESULT ===
      status: no_action|updated_pr|completed|abandoned|failed
      work_item_id: {id}
      pull_request_id: {prId}
      head_commit_id: <sha or empty>
      notes: <one-line>
      === END DEV_DAEMON_RESULT ===
      ```
14. Implement `buildSummarizePrompt(workItemId, title, priorOutput, existingContextContent)`:
    - "Do NOT take any development actions. Read the prior session output and existing context (both provided below). Write a compressed context.md to `{contextPath}`. Be ruthlessly concise — target under 150 lines. Overwrite, do not append."
    - Passes both `priorOutput` and `existingContextContent` inline in the prompt
    - No HITL instruction needed (no decisions to make)
    - Result block:
      ```
      === DEV_DAEMON_RESULT ===
      status: saved|failed
      context_path: <path>
      === END DEV_DAEMON_RESULT ===
      ```
15. Implement `parseResultBlock(output)`:
    - Extracts `=== DEV_DAEMON_RESULT ===` block from Claude output as key-value pairs
    - Fallback: heuristic PR ID search in output if block missing
    - *Steps 11–15 parallel*

---

## Phase 5 — WI Discovery & Priority Orchestration

15. Implement `discoverWorkItems(witApi, project, developerUpn)`:
    - WIQL: `SELECT [System.Id], [System.Title], [System.State], [System.AssignedTo], [System.ChangedDate] FROM WorkItems WHERE [System.AssignedTo] = '{developerUpn}' AND [System.State] NOT IN ('Closed','Done','Removed') AND [System.WorkItemType] IN ('User Story','Bug','Task','Feature') ORDER BY [System.ChangedDate] DESC`
    - Batch fetch with `witApi.getWorkItems(ids, fields)`
    - Merge with existing dev-state: preserve known, add `discovered` for new, remove closed
16. Implement `DevRepoWorker` class in `dev-daemon.ts` (mirrors `RepoWorker` from daemon.ts):
    - Properties: `repo`, `state`, `gitApi`, `witApi`, `connection`
    - Methods: `runOnce()`, `runLoop()`
    - *Depends on steps 6–15*
17. Implement `runOnce()` processing order — **CRITICAL, must be this priority**:
    1. **Babysit PRs first** (`pr_babysitting`): `checkPrChanged()` → `shouldInvokeBabysit()` → spawn Claude if needed. Always snapshot new thread/build counts even when Claude not spawned.
    2. **Check plan approvals** (`needs_plan`): `scanWiApproval()` only if comment count changed → transition to `plan_approved` if keyword found. No Claude.
    3. **Retry errored items** (`implementing` where `backoffUntil < now`): re-invoke Phase 2
    4. **Start approved work** (`plan_approved`): if global WIP < `MAX_WIP_ITEMS`, invoke Phase 2
    5. **Post new plans** (`discovered`): if global WIP < `MAX_WIP_ITEMS`, invoke Phase 1
    - WIP count = items in `needs_plan | plan_approved | implementing | pr_babysitting`
    - *Depends on step 16*

---

## Phase 6 — Claude Invocation & Result Handling

18. Reuse `runClaude(prompt, cwd, workItemId, repo, opts?)` from `daemon.ts` — extend with two new options:
    - `opts.timeoutMs` — override timeout (default 30min; 5min for summarize)
    - `opts.sessionId` — if provided, pass `--session-id {id}` to resume an existing Claude session instead of starting fresh. If omitted, generate a new UUID.
    - Always capture the sessionId used (whether new or resumed) and return it in the result.
    - Spawns `claude -p --dangerously-skip-permissions --model opus --session-id {id}`, pipes prompt via stdin, saves output to `review-results/wi-{id}-{timestamp}.md`.

### Session reuse strategy
The daemon stores per-phase session IDs in state (`planSessionId`, `implSessionId`, `babysitSessionId`). On each invocation:

- **Plan (Phase 1)**: First call generates a new session. If plan fails and we retry, pass `planSessionId` to resume — Claude sees what it already tried.
- **Implementation (Phase 2)**: First call generates a new session. On retry after failure, pass `implSessionId` to resume — Claude sees its partial progress + error.
- **Babysit**: First babysit generates a new session. Subsequent babysit cycles **reuse the same session** (Claude accumulates full babysit history). Reset to a new session every 5 babysit turns (`babysitSessionTurnCount >= 5`) to prevent context bloat.
- **Summarize**: Always a **fresh session** — no reuse. Short-lived, read-only task.

When a WI transitions to a new phase (e.g. `needs_plan → implementing`), the previous phase session is **not** carried forward — instead, the context.md bridges phases. This keeps sessions focused per-phase and prevents cross-phase context pollution.

Capture flow:
- `runClaude()` returns `{ exitCode, output, sessionId }`
- Daemon persists `sessionId` to the correct state field immediately after the call
- On next invocation for the same WI+phase, reads the stored sessionId and passes it as `opts.sessionId`

19. Implement `runWithMemory(primaryPrompt, cwd, workItemId, repo, phaseSessionId?)` — **wrapper used for every Claude invocation**:
    - Step A: `await runClaude(primaryPrompt, cwd, workItemId, repo, { sessionId: phaseSessionId })` — primary session (30min timeout, resume if sessionId provided)
    - Step B: Always (regardless of exit code): build summarize prompt from primary output + existing context.md, then `await runClaude(summarizePrompt, cwd, workItemId, repo, { timeoutMs: 5*60*1000 })` — always fresh session for summarize
    - Returns primary result + sessionId used; caller stores sessionId in state
    - *Depends on step 18*

20. Implement `handleImplementationResult(state, result, workItemEntry)`:
    - Parse result block
    - `status: success` + `pull_request_id` present → transition to `pr_babysitting`, call `checkPrChanged()` immediately to snapshot baseline thread/build counts
    - `status: success` + no PR id → query ADO for PR by source branch as fallback
    - Failure → increment `implementationAttempts`; `backoffUntil = now + 5min × 2^(attempts-1)`; at 3 failures → `abandoned` + post failure comment on WI
    - *Depends on steps 15, 19*

21. Implement `handleBabysitResult(state, result, workItemEntry)`:
    - `status: completed` → transition to `completed`, call `cleanupWorkItemWorktree()`
    - `status: abandoned` → transition to `abandoned` (keep worktree, keep context file)
    - `status: no_action|updated_pr` → stay `pr_babysitting`, update `lastBabysitClaudeAt`
    - 5 consecutive babysit failures → post WI comment + abandon
    - *Depends on steps 15, 19*

---

## Phase 7 — Entry Point & Dashboard

21. Implement `main()` with 3 modes (same pattern as `daemon.ts`):
    - Default: continuous loop (`runLoop()` per repo)
    - `once`: single `runOnce()` per repo, then exit
    - `dashboard`: print state table — WI id, title, state, PR id, babysit count, last action
    - `if (require.main === module)` guard
22. Multi-repo via `repos.json`; `MAX_WIP_ITEMS` is a **global** limit summed across all repos. Each repo gets its own `dev-state-{repoName}.json`.

---

## Relevant Files

- `B:\sources\revobot\src\dev-daemon.ts` — **new** — orchestrator + `DevRepoWorker` + `runWithMemory()` + entry point
- `B:\sources\revobot\src\dev-state.ts` — **new** — state types + load/save helpers
- `B:\sources\revobot\src\dev-prompts.ts` — **new** — 4 prompt builders (plan, implementation, babysit, summarize) + `parseResultBlock()`
- `B:\sources\revobot\src\daemon.ts` — **reference** — reuse: `createConnection`, `AutoRefreshBearerHandler`, `logActivity`, `runClaude`, `git`/`gitSafe`, `loadCustomPrompt`, CLI entry pattern, `RepoWorker` class structure
- `B:\sources\revobot\src\pr-review-policy.ts` — **reference** — change-detection gate pattern (unchanged commit → ignore; recency delay → wait)
- `B:\sources\revobot\repos.json` — **read** — no schema changes needed
- `B:\sources\revobot\package.json` — **modify** — add 3 scripts
- `B:\sources\revobot\.env` — **modify** — add 7 new env vars
- `B:\sources\claude_plugins\ado\skills\work-on\SKILL.md` — invoked in Phase 1 & 2 prompts
- `B:\sources\claude_plugins\ado\skills\babysit-pr\SKILL.md` — invoked in babysit prompts
- `B:\sources\claude_plugins\code-reviewer\skills\pr-review\SKILL.md` — self-review in Phase 2 prompt

---

## Verification

1. `npm run dev-daemon:once` with no approved WIs → connects, runs WIQL, prints table, exits — **zero Claude spawns**
2. Insert `discovered` entry manually into `dev-state-{repo}.json` → confirm `buildPlanPrompt` called, Claude spawned in correct worktree dir
3. Post "approved, go ahead" comment on WI in ADO → next cycle: keyword detected, state → `plan_approved`, **no Claude invoked** for detection
4. Set `MAX_WIP_ITEMS=1` with 1 item already `implementing` → `plan_approved` item stays deferred
5. Set state to `pr_babysitting` with `lastPrThreadCount=3`, add PR comment → Claude spawned with babysit prompt
6. Same cycle with NO new PR comments + NO build change → Claude **not** spawned
7. Set `babysitInvocations=20` → babysit skipped despite PR activity (cap reached)
8. `npm run dev-daemon:dashboard` → state table renders correctly for all repos

9. `npm run dev-daemon:once`, after a Claude session completes — confirm `context.md` written to `{DEV_WORKTREE_BASE}/.scratchpad/wi-{id}/context.md`, under 150 lines
10. On second cycle for same WI — confirm `contextFilePath` is included in the next primary prompt (visible in saved `results/prompt-wi-{id}.md`)

---

## Decisions

- **New file, not merged into daemon.ts** — reviewer and developer are separate concerns; independently startable, separate state files
- **Approval = WI comment keyword scan in daemon** — no ADO State field, no Claude; configurable via `APPROVAL_KEYWORDS` env var; default keywords: "approved", "go ahead", "let's", "proceed", "implement", "rock", "lgtm", "ship it", "do it"
- **`work-on` 2-phase maps to daemon state machine**: Phase 1 (plan) = `needs_plan` invocation; Phase 2 (implement) = `implementing` invocation. Two separate Claude invocations.
- **Single Claude invocation for Phase 2** covers: implement → self-review × 2 → publish PR
- **Session memory via `runWithMemory()`**: every primary Claude session is always followed by a 5-minute summarize session that compresses state into `context.md`. Next session reads this file first. Enables continuity without ballooning context size.
- **Session reuse via `--session-id`**: per-phase session IDs stored in state (`planSessionId`, `implSessionId`, `babysitSessionId`). On retry or next babysit cycle, the daemon resumes the existing session so Claude sees full conversation history. Babysit sessions reset every 5 turns to prevent context bloat. Session IDs do NOT carry across phases — `context.md` bridges those transitions.
- **Context file is always overwritten** (not appended) — always reflects latest state, never grows unboundedly
- **HITL mandatory in all primary prompts** — every prompt to Claude includes the instruction to use `mcp__hitl__AskUserQuestion` for any question or decision that needs human input. Claude should never block or guess when it can ask.
- **Global WIP limit** across all repos (not per-repo), default 2
- **Processing priority**: babysit PRs → check approvals → retry errors → start new implementations → post new plans
- **Exponential backoff**: 5m → 10m → abandon at 3rd failure
- **Abandoned worktrees kept** for forensic recovery; only `completed` worktrees auto-deleted
- **`=== DEV_DAEMON_RESULT ===` result block** for deterministic output parsing; heuristic fallback if missing
- **Per-repo custom prompts** via `dev-prompt-{repoName}.md` (same pattern as `review-prompt-{repoName}.md`)
- **`DEVELOPER_UPN` env var** for WI discovery — not auto-derived from auth token, simpler and explicit
