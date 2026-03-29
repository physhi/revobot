/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import type { PrReviewDocument, PrThread, PrThreadComment, PrCommit } from "./track-prs";

// ---------------------------------------------------------------------------
// Query result
// ---------------------------------------------------------------------------
interface PrQueryResult {
  prId: number;
  title: string;
  sourceBranch: string;
  targetBranch: string;
  baseCommitId: string;
  latestSourceCommitId: string;
  sinceTimestamp: string;
  updatedThreads: {
    threadId: number;
    status: string;
    filePath?: string;
    lineNumber?: number;
    iterationId?: number;
    iterationSourceCommit?: string;
    newComments: PrThreadComment[];       // comments added after sinceTimestamp
    priorComments: PrThreadComment[];     // earlier comments in the same thread (context)
  }[];
  modifiedFiles: string[];                // unique file paths from iterations since timestamp
  newCommits: PrCommit[];                 // commits added since timestamp
}

// ---------------------------------------------------------------------------
// Core query logic
// ---------------------------------------------------------------------------
function queryPr(doc: PrReviewDocument, since: string): PrQueryResult {
  // 1. Find threads with new comments
  const updatedThreads = doc.threads
    .map((thread) => {
      const newComments = thread.comments.filter((c) => c.publishedDate > since);
      if (newComments.length === 0) return null;

      const priorComments = thread.comments.filter((c) => c.publishedDate <= since);

      return {
        threadId: thread.threadId,
        status: thread.status,
        filePath: thread.filePath,
        lineNumber: thread.lineNumber,
        iterationId: thread.iterationId,
        iterationSourceCommit: thread.iterationSourceCommit,
        newComments,
        priorComments,
      };
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  // 2. Find iterations created after the timestamp
  const newIterations = doc.iterations.filter((it) => it.createdDate > since);

  // 3. Collect unique file paths from updated threads
  const fileSet = new Set<string>();
  for (const thread of updatedThreads) {
    if (thread.filePath) fileSet.add(thread.filePath);
  }
  const modifiedFiles = Array.from(fileSet).sort();

  // 4. Commits added since timestamp
  const newCommits = doc.commits.filter((c) => c.date > since);

  return {
    prId: doc.prId,
    title: doc.title,
    sourceBranch: doc.sourceBranch,
    targetBranch: doc.targetBranch,
    baseCommitId: doc.baseCommitId,
    latestSourceCommitId: doc.latestSourceCommitId,
    sinceTimestamp: since,
    updatedThreads,
    modifiedFiles,
    newCommits,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
//   Usage: npx ts-node src/query-pr.ts <since-timestamp> <pr-json-path>
//   Example: npx ts-node src/query-pr.ts 2026-03-20T01:00:00Z pr-docs/pr-5020705.json
// ---------------------------------------------------------------------------
function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx ts-node src/query-pr.ts <since-timestamp> <pr-json-path>");
    console.error("Example: npx ts-node src/query-pr.ts 2026-03-20T01:00:00Z pr-docs/pr-5020705.json");
    process.exit(1);
  }

  const since = new Date(args[0]).toISOString();
  const jsonPath = path.resolve(args[1]);

  if (!fs.existsSync(jsonPath)) {
    console.error(`File not found: ${jsonPath}`);
    process.exit(1);
  }

  const doc: PrReviewDocument = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const result = queryPr(doc, since);

  // Print summary to stderr, JSON to stdout (so you can pipe it)
  const newCommentCount = result.updatedThreads.reduce((n, t) => n + t.newComments.length, 0);
  console.error(`PR #${result.prId}: ${result.title}`);
  console.error(`Since: ${since}`);
  console.error(`Updated threads: ${result.updatedThreads.length} (${newCommentCount} new comments)`);
  console.error(`Modified files:  ${result.modifiedFiles.length}`);
  console.error(`New commits:     ${result.newCommits.length}`);
  console.error("");

  console.log(JSON.stringify(result, null, 2));
}

main();
