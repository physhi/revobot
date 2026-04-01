#!/usr/bin/env node
/**
 * Standalone knowledge extraction script.
 * Reads a work item's context.md and/or raw session output, extracts
 * architectural learnings, and appends them to architecture-knowledge.md.
 *
 * Usage:
 *   npx ts-node src/extract-knowledge.ts <workItemId> [contextFilePath]
 *   npm run extract-knowledge -- <workItemId> [contextFilePath]
 *
 * If contextFilePath is omitted, it defaults to the standard scratchpad path.
 * Can also read from stdin for piping raw session output.
 */

import * as fs from "fs";
import * as path from "path";
import { buildKnowledgeExtractionPrompt } from "./dev-prompts";
import { spawn } from "child_process";

const KNOWLEDGE_FILE = path.resolve("scratchpad", "architecture-knowledge.md");

function usage(): never {
  console.error(`Usage: extract-knowledge <workItemId> [title] [contextFilePath]

Arguments:
  workItemId       Work item ID (number)
  title            Work item title (optional, defaults to "Manual extraction")
  contextFilePath  Path to context.md (optional, auto-detected from scratchpad)

Examples:
  npm run extract-knowledge -- 12345
  npm run extract-knowledge -- 12345 "Add auth feature" ./path/to/context.md
`);
  process.exit(1);
}

async function runClaude(prompt: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", ["-p", "--dangerously-skip-permissions", "--model", "sonnet", "--", "-"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ exitCode: 1, output: "Timed out after 5 minutes" });
      }
    }, 5 * 60 * 1000);

    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: 1, output: `spawn error: ${err.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, output: stdout + (stderr ? `\n${stderr}` : "") });
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();

  const workItemId = parseInt(args[0], 10);
  if (isNaN(workItemId)) {
    console.error(`Error: "${args[0]}" is not a valid work item ID`);
    usage();
  }

  const title = args[1] || "Manual extraction";

  // Auto-detect context file
  let contextFilePath = args[2] || null;
  if (!contextFilePath) {
    const autoPath = path.resolve(".scratchpad", `wi-${workItemId}`, "context.md");
    if (fs.existsSync(autoPath)) {
      contextFilePath = autoPath;
      console.log(`[Knowledge] Auto-detected context: ${autoPath}`);
    }
  }

  // Ensure knowledge file directory exists
  const knowledgeDir = path.dirname(KNOWLEDGE_FILE);
  if (!fs.existsSync(knowledgeDir)) {
    fs.mkdirSync(knowledgeDir, { recursive: true });
  }

  // Seed knowledge file if it doesn't exist
  if (!fs.existsSync(KNOWLEDGE_FILE)) {
    fs.writeFileSync(KNOWLEDGE_FILE, `# Architecture Knowledge Base
<!-- 
  Auto-extracted learnings from development sessions.
  Each entry is a concise decision/pattern (≤4 lines).
  Agents: Read this file before starting work on this repo.
  Format: ### YYYY-MM-DD — Context  \\n  - Learning
-->
`);
    console.log(`[Knowledge] Created ${KNOWLEDGE_FILE}`);
  }

  console.log(`[Knowledge] Extracting learnings for WI-${workItemId}: "${title}"`);
  console.log(`[Knowledge] Context: ${contextFilePath || "(none)"}`);
  console.log(`[Knowledge] Target: ${KNOWLEDGE_FILE}`);

  const prompt = buildKnowledgeExtractionPrompt(workItemId, title, contextFilePath, KNOWLEDGE_FILE);
  const result = await runClaude(prompt, process.cwd());

  if (result.exitCode === 0) {
    console.log(`[Knowledge] ✓ Extraction complete (exit 0)`);
  } else {
    console.error(`[Knowledge] ✗ Extraction failed (exit ${result.exitCode})`);
  }

  // Show what was appended
  const knowledgeContent = fs.readFileSync(KNOWLEDGE_FILE, "utf-8");
  const lines = knowledgeContent.split("\n");
  const lastSection = lines.slice(-10).join("\n").trim();
  if (lastSection) {
    console.log(`\n--- Latest entries ---\n${lastSection}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
