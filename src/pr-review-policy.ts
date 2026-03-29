import { getPrLastActivityTimestamp, parseTimestamp, PullRequestLike } from "./pr-idle";

const DEFAULT_PR_ACTIVITY_SETTLE_DELAY_MINUTES = 15;
const DEFAULT_PR_REREVIEW_COOLDOWN_MINUTES = 60;

function parseEnvMinutes(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const PR_ACTIVITY_SETTLE_DELAY_MINUTES = parseEnvMinutes(
  process.env.PR_ACTIVITY_SETTLE_DELAY_MINUTES,
  DEFAULT_PR_ACTIVITY_SETTLE_DELAY_MINUTES,
);

export const PR_REREVIEW_COOLDOWN_MINUTES = parseEnvMinutes(
  process.env.PR_REREVIEW_COOLDOWN_MINUTES,
  DEFAULT_PR_REREVIEW_COOLDOWN_MINUTES,
);

export const PR_ACTIVITY_SETTLE_DELAY_MS = PR_ACTIVITY_SETTLE_DELAY_MINUTES * 60 * 1000;
export const PR_REREVIEW_COOLDOWN_MS = PR_REREVIEW_COOLDOWN_MINUTES * 60 * 1000;

interface PreviousReviewStateLike {
  lastReviewedAt: string;
  lastSourceCommitId: string;
}

interface ReviewWaitReason {
  label: string;
  remainingMs: number;
}

type ReviewDecision =
  | {
      kind: "review-new";
      latestSourceCommitId: string;
      sinceTimestamp: null;
    }
  | {
      kind: "review-updated";
      latestSourceCommitId: string;
      sinceTimestamp: string;
    }
  | {
      kind: "wait";
      latestSourceCommitId: string;
      sinceTimestamp: string | null;
      remainingMs: number;
      reasons: ReviewWaitReason[];
    }
  | {
      kind: "ignore";
      latestSourceCommitId: string;
      sinceTimestamp: string | null;
    };

function getRemainingDelayMs(timestamp: number | null, delayMs: number, now: number): number {
  if (timestamp === null) return 0;
  return Math.max(0, timestamp + delayMs - now);
}

function formatRemainingDuration(remainingMs: number): string {
  const remainingMinutes = Math.ceil(remainingMs / 60000);
  if (remainingMinutes >= 60) {
    const hours = Math.floor(remainingMinutes / 60);
    const minutes = remainingMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  return `${remainingMinutes}m`;
}

export function getPrReviewDecision(
  pr: PullRequestLike,
  previous: PreviousReviewStateLike | null,
  now = Date.now(),
): ReviewDecision {
  const latestSourceCommitId = pr.lastMergeSourceCommit?.commitId ?? "";

  if (!previous) {
    const creationTimestamp = parseTimestamp(pr.creationDate);
    const remainingMs = getRemainingDelayMs(creationTimestamp, PR_ACTIVITY_SETTLE_DELAY_MS, now);
    if (remainingMs > 0) {
      return {
        kind: "wait",
        latestSourceCommitId,
        sinceTimestamp: null,
        remainingMs,
        reasons: [
          { label: `new PR settle delay (${PR_ACTIVITY_SETTLE_DELAY_MINUTES}m)`, remainingMs },
        ],
      };
    }

    return { kind: "review-new", latestSourceCommitId, sinceTimestamp: null };
  }

  if (!latestSourceCommitId || latestSourceCommitId === previous.lastSourceCommitId) {
    return { kind: "ignore", latestSourceCommitId, sinceTimestamp: previous.lastReviewedAt };
  }

  const reasons: ReviewWaitReason[] = [];
  const activityTimestamp = getPrLastActivityTimestamp(pr);
  const settleRemainingMs = getRemainingDelayMs(activityTimestamp, PR_ACTIVITY_SETTLE_DELAY_MS, now);
  if (settleRemainingMs > 0) {
    reasons.push({
      label: `post-update settle delay (${PR_ACTIVITY_SETTLE_DELAY_MINUTES}m)`,
      remainingMs: settleRemainingMs,
    });
  }

  const reviewTimestamp = parseTimestamp(previous.lastReviewedAt);
  const rereviewRemainingMs = getRemainingDelayMs(reviewTimestamp, PR_REREVIEW_COOLDOWN_MS, now);
  if (rereviewRemainingMs > 0) {
    reasons.push({
      label: `re-review cooldown (${PR_REREVIEW_COOLDOWN_MINUTES}m)`,
      remainingMs: rereviewRemainingMs,
    });
  }

  if (reasons.length > 0) {
    return {
      kind: "wait",
      latestSourceCommitId,
      sinceTimestamp: previous.lastReviewedAt,
      remainingMs: Math.max(...reasons.map((reason) => reason.remainingMs)),
      reasons,
    };
  }

  return {
    kind: "review-updated",
    latestSourceCommitId,
    sinceTimestamp: previous.lastReviewedAt,
  };
}

export function formatPrReviewWait(decision: Extract<ReviewDecision, { kind: "wait" }>): string {
  const reasonText = decision.reasons
    .map((reason) => `${reason.label}, ${formatRemainingDuration(reason.remainingMs)} remaining`)
    .join("; ");

  return `${reasonText}; eligible in ~${formatRemainingDuration(decision.remainingMs)}`;
}