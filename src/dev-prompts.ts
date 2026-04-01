import * as fs from "fs";
import * as path from "path";

const KNOWLEDGE_FILE = path.resolve("scratchpad", "architecture-knowledge.md");

/**
 * Loads the architecture knowledge base and formats it as a prompt section.
 * Returns empty string if no knowledge file exists or it's empty.
 */
function loadKnowledgeSection(): string {
    if (!fs.existsSync(KNOWLEDGE_FILE)) return "";
    const content = fs.readFileSync(KNOWLEDGE_FILE, "utf-8").trim();
    if (!content || content.split("\n").length <= 7) return ""; // header-only
    return `\n## Architecture Knowledge Base
The following are accumulated learnings from past development sessions on this repo. Keep these in mind:

${content}

`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// PLAN PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Builds the planning prompt for Phase 1 of the autonomous development workflow.
 * Instructs Claude to create a design plan and post it to work item comments for approval.
 * 
 * @param workItem - Work item details (id and title)
 * @param worktreePath - Path to the git worktree
 * @param repoContext - Repository context (org, project, repo)
 * @param customPrompt - Additional custom instructions
 * @param contextFilePath - Optional path to existing session context file
 * @returns Formatted prompt string
 */
export function buildPlanPrompt(
    workItem: { workItemId: number; title: string },
    worktreePath: string,
    repoContext: { orgUrl: string; project: string; repository: string },
    customPrompt: string,
    contextFilePath?: string | null
): string {
    const contextInstruction = contextFilePath && fs.existsSync(contextFilePath) 
        ? `Your previous session context for this work item is at \`${contextFilePath}\`. Read it first before doing anything else.\n\n`
        : "";

    const knowledgeSection = loadKnowledgeSection();

    const customSection = customPrompt.trim() 
        ? `\n## Additional Instructions\n${customPrompt.trim()}\n`
        : "";

    return `${contextInstruction}You are an autonomous software developer working on Azure DevOps work items. Load the \`ado:work-on\` skill to begin.

## Phase 1 — Planning
This is **Phase 1** — post a design plan to the work item comments for developer approval. Do NOT implement yet.

## Work Item Details
- **Work Item ID**: #${workItem.workItemId}
- **Title**: ${workItem.title}
- **Organization**: ${repoContext.orgUrl}
- **Project**: ${repoContext.project}
- **Repository**: ${repoContext.repository}
- **Working Directory**: ${worktreePath}

## Your Task
1. Analyze the work item requirements thoroughly
2. Design a comprehensive solution approach
3. Post your design plan as a comment on the work item for developer approval
4. Wait for approval before proceeding to implementation
${customSection}
${knowledgeSection}IMPORTANT: If you need to ask the user a question, get clarification, or request a decision at any point, use the \`mcp__hitl__AskUserQuestion\` MCP tool. Do not block, do not guess — ask via HITL.

When you are completely done, output this result block at the very end:
=== DEV_DAEMON_RESULT ===
status: plan_posted|blocked|failed
work_item_id: ${workItem.workItemId}
plan_comment_id: <id of the comment you posted, or empty>
summary: <one-line summary of what happened>
=== END DEV_DAEMON_RESULT ===`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Builds the implementation prompt for Phase 2 of the autonomous development workflow.
 * Instructs Claude to implement the approved plan, self-review, and publish a PR.
 * 
 * @param workItem - Work item details (id and title)
 * @param worktreePath - Path to the git worktree
 * @param planCommentId - ID of the approved plan comment
 * @param repoContext - Repository context (org, project, repo)
 * @param customPrompt - Additional custom instructions
 * @param contextFilePath - Optional path to existing session context file
 * @returns Formatted prompt string
 */
export function buildImplementationPrompt(
    workItem: { workItemId: number; title: string },
    worktreePath: string,
    planCommentId: number | null,
    repoContext: { orgUrl: string; project: string; repository: string },
    customPrompt: string,
    contextFilePath?: string | null
): string {
    const contextInstruction = contextFilePath && fs.existsSync(contextFilePath)
        ? `Your previous session context for this work item is at \`${contextFilePath}\`. Read it first before doing anything else.\n\n`
        : "";

    const planReference = planCommentId 
        ? `The approved plan was posted as comment #${planCommentId} on the work item.\n\n`
        : "";

    const knowledgeSection = loadKnowledgeSection();

    const customSection = customPrompt.trim()
        ? `\n## Additional Instructions\n${customPrompt.trim()}\n`
        : "";

    return `${contextInstruction}You are an autonomous software developer working on Azure DevOps work items. Load the \`ado:work-on\` skill to begin.

## Phase 2 — Implementation
This is **Phase 2** — the developer has approved the plan. Implement the approved plan now.

## Work Item Details
- **Work Item ID**: #${workItem.workItemId}
- **Title**: ${workItem.title}
- **Organization**: ${repoContext.orgUrl}
- **Project**: ${repoContext.project}
- **Repository**: ${repoContext.repository}
- **Working Directory**: ${worktreePath}

${planReference}## Your Task
1. Implement the approved plan completely
2. Write appropriate tests for your changes
3. Ensure all existing tests continue to pass
4. Follow coding standards and best practices

## Self-Review and PR Publication
Once implementation is complete, load the \`code-reviewer:pr-review\` skill and self-review your changes. Apply fixes from the review. Repeat self-review one more time (2 total iterations of: review → fix). Then publish a PR to Azure DevOps.
${customSection}
${knowledgeSection}IMPORTANT: If you need to ask the user a question, get clarification, or request a decision at any point, use the \`mcp__hitl__AskUserQuestion\` MCP tool. Do not block, do not guess — ask via HITL.

When you are completely done, output this result block at the very end:
=== DEV_DAEMON_RESULT ===
status: success|blocked|failed
work_item_id: ${workItem.workItemId}
branch_name: <branch name>
pull_request_id: <PR number or empty>
pull_request_url: <URL or empty>
head_commit_id: <commit SHA or empty>
review_iterations_completed: <0|1|2>
summary: <one-line summary>
=== END DEV_DAEMON_RESULT ===`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// BABYSIT PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Builds the babysit prompt for PR monitoring and maintenance.
 * Instructs Claude to address changes in PR threads, comments, builds, and tests.
 * 
 * @param workItem - Work item details (id and title)
 * @param prId - Pull request ID
 * @param worktreePath - Path to the git worktree
 * @param changeContext - Details about what changed since last check
 * @param repoContext - Repository context (org, project, repo)
 * @param contextFilePath - Optional path to existing session context file
 * @returns Formatted prompt string
 */
export function buildBabysitPrompt(
    workItem: { workItemId: number; title: string },
    prId: number,
    worktreePath: string,
    changeContext: { 
        threadDelta: number; 
        commentDelta: number; 
        buildChanged: boolean; 
        newBuildStatus?: string; 
        testChanged: boolean 
    },
    repoContext: { orgUrl: string; project: string; repository: string },
    contextFilePath?: string | null
): string {
    const contextInstruction = contextFilePath && fs.existsSync(contextFilePath)
        ? `Your previous session context for this work item is at \`${contextFilePath}\`. Read it first before doing anything else.\n\n`
        : "";

    const knowledgeSection = loadKnowledgeSection();
    const buildStatus = changeContext.newBuildStatus || "unknown";
    const testChangedText = changeContext.testChanged ? "yes" : "no";

    return `${contextInstruction}You are an autonomous software developer babysitting a pull request. Load the \`ado:babysit-pr\` skill to begin.

## PR Babysitting
- **Work Item ID**: #${workItem.workItemId}
- **Title**: ${workItem.title}
- **Pull Request ID**: #${prId}
- **Organization**: ${repoContext.orgUrl}
- **Project**: ${repoContext.project}
- **Repository**: ${repoContext.repository}
- **Working Directory**: ${worktreePath}

## Changes Since Last Check
Since last check: ${changeContext.threadDelta} new thread(s), ${changeContext.commentDelta} new comment(s), build status: ${buildStatus}, test results changed: ${testChangedText}

## Your Task
Address what changed. Do NOT re-implement the feature from scratch. Do NOT create a new PR.

1. Review new reviewer comments and feedback
2. Address any build failures or test failures
3. Respond to reviewer questions appropriately
4. Make minimal, targeted fixes for any issues found
5. Push updates to the existing PR branch
${knowledgeSection}
IMPORTANT: If you need to ask the user a question, get clarification, or request a decision at any point, use the \`mcp__hitl__AskUserQuestion\` MCP tool. Do not block, do not guess — ask via HITL.

When you are completely done, output this result block at the very end:
=== DEV_DAEMON_RESULT ===
status: no_action|updated_pr|completed|abandoned|failed
work_item_id: ${workItem.workItemId}
pull_request_id: ${prId}
head_commit_id: <SHA or empty>
notes: <one-line>
=== END DEV_DAEMON_RESULT ===`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// SUMMARIZE PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Builds the summarize prompt for compressing session context.
 * Instructs Claude to create a compressed context.md file for future sessions.
 * 
 * @param workItemId - Work item ID
 * @param title - Work item title
 * @param worktreePath - Path to the git worktree
 * @param priorOutput - Previous session output to summarize
 * @param existingContextContent - Existing context content to merge
 * @returns Formatted prompt string
 */
export function buildSummarizePrompt(
    workItemId: number,
    title: string,
    worktreePath: string,
    priorOutput: string,
    existingContextContent?: string | null
): string {
    const contextPath = path.resolve(worktreePath, '../../.scratchpad/wi-' + workItemId + '/context.md');
    
    // Truncate priorOutput to last 50000 chars if huge
    const truncatedOutput = priorOutput.length > 50000 
        ? "...\n" + priorOutput.slice(-50000)
        : priorOutput;

    const existingContextSection = existingContextContent
        ? `\n## Existing Context Content\n\`\`\`markdown\n${existingContextContent}\n\`\`\``
        : "";

    return `You are a session summarizer. Do NOT take any development actions. Do NOT modify any code. Do NOT run any commands except writing the context file.

## Your Task
Read the prior session output below and the existing context (if any). Write a compressed context.md to \`${contextPath}\`. Be ruthlessly concise — target under 150 lines. Overwrite the file, do not append.

## Context File Schema
Use this exact structure:

\`\`\`markdown
# WI ${workItemId} — ${title}

## Status
- Current state: {state}
- Last session: {ISO timestamp}
- Next step: {what to do next}

## What was done
- {Bullet per action}

## Implementation decisions
- {Key choices with rationale}

## Open questions / blockers
- {Unresolved items}

## Unresolved reviewer comments
- {Thread + snippet + status}

## Important file paths
- {Files touched}

## Learnings
- {Non-obvious discoveries}
\`\`\`

## Prior Session Output
\`\`\`
${truncatedOutput}
\`\`\`${existingContextSection}

When you are completely done, output this result block at the very end:
=== DEV_DAEMON_RESULT ===
status: saved|failed
context_path: <path written>
=== END DEV_DAEMON_RESULT ===`;
}

/**
 * Builds a prompt for extracting architectural knowledge after a work item completes.
 * This is a lightweight, read-only call — the agent writes ≤4 concise learnings
 * to the shared architecture knowledge file.
 *
 * @param workItemId - Work item ID
 * @param title - Work item title
 * @param contextFilePath - Path to the WI's compressed context.md
 * @param knowledgeFilePath - Path to the shared architecture-knowledge.md
 * @returns Formatted prompt string
 */
export function buildKnowledgeExtractionPrompt(
    workItemId: number,
    title: string,
    contextFilePath: string | null,
    knowledgeFilePath: string,
): string {
    const contextInstruction = contextFilePath && fs.existsSync(contextFilePath)
        ? `Read the work item context at \`${contextFilePath}\` for details of what was done.`
        : "No prior context file available — extract learnings from the result block below.";

    const existingKnowledge = fs.existsSync(knowledgeFilePath)
        ? fs.readFileSync(knowledgeFilePath, "utf-8")
        : "";

    return `You are an architecture knowledge extractor. Do NOT take any development actions. Do NOT modify code. Do NOT run commands except appending to the knowledge file.

## Your Task
Extract 2-5 concise architectural learnings from work item WI-${workItemId} ("${title}") and APPEND them to \`${knowledgeFilePath}\`.

${contextInstruction}

## Rules
1. Each learning must be ≤4 lines (ideally 1-2 lines).
2. Focus on: design decisions, API gotchas, patterns that worked/failed, non-obvious behaviors.
3. Do NOT repeat learnings already in the file.
4. Do NOT include implementation details — only things the NEXT developer/agent needs to know.
5. Use this exact format when appending:

\`\`\`
### ${new Date().toISOString().slice(0, 10)} — WI-${workItemId}: ${title}
- Learning one.
- Learning two.
\`\`\`

## Existing Knowledge File
\`\`\`markdown
${existingKnowledge}
\`\`\`

## Instructions
1. Read the context file (if available).
2. Identify non-obvious learnings that differ from what's already in the knowledge file.
3. Append new entries to \`${knowledgeFilePath}\`. If no new learnings, append nothing.
4. Output the result block below.

=== DEV_DAEMON_RESULT ===
status: saved|no_new_learnings
entries_added: <number>
=== END DEV_DAEMON_RESULT ===`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// RESULT PARSING
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Parses the DEV_DAEMON_RESULT block from Claude output.
 * Extracts key-value pairs from the structured result block.
 * 
 * @param output - Raw output from Claude
 * @returns Parsed result object or null if block not found
 */
export function parseResultBlock(output: string): Record<string, string> | null {
    const startMarker = "=== DEV_DAEMON_RESULT ===";
    const endMarker = "=== END DEV_DAEMON_RESULT ===";
    
    const startIndex = output.indexOf(startMarker);
    if (startIndex === -1) {
        return null;
    }
    
    const endIndex = output.indexOf(endMarker, startIndex);
    if (endIndex === -1) {
        return null;
    }
    
    const blockContent = output.slice(startIndex + startMarker.length, endIndex).trim();
    const result: Record<string, string> = {};
    
    for (const line of blockContent.split('\n')) {
        const trimmedLine = line.trim();
        if (!trimmedLine) continue;
        
        const colonIndex = trimmedLine.indexOf(':');
        if (colonIndex === -1) continue;
        
        const key = trimmedLine.slice(0, colonIndex).trim();
        const value = trimmedLine.slice(colonIndex + 1).trim();
        
        if (key && value) {
            result[key] = value;
        }
    }
    
    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Fallback helper to extract PR ID from output using regex patterns.
 * Used when the result block is missing or doesn't contain PR ID.
 * 
 * @param output - Raw output from Claude
 * @returns Extracted PR ID or null if not found
 */
export function extractPrIdFallback(output: string): number | null {
    // Try various patterns to find PR ID
    const patterns = [
        /PR #(\d+)/i,
        /pull request #?(\d+)/i,
        /pullRequestId:\s*(\d+)/i,
        /pr_id:\s*(\d+)/i,
        /pull_request_id:\s*(\d+)/i
    ];
    
    for (const pattern of patterns) {
        const match = output.match(pattern);
        if (match) {
            const prId = parseInt(match[1], 10);
            if (!isNaN(prId)) {
                return prId;
            }
        }
    }
    
    return null;
}