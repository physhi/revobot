const DEFAULT_PR_IDLE_THRESHOLD_HOURS = 72;

const parsedIdleThresholdHours = Number.parseInt(
  process.env.PR_IDLE_THRESHOLD_HOURS ?? String(DEFAULT_PR_IDLE_THRESHOLD_HOURS),
  10,
);

export const PR_IDLE_THRESHOLD_HOURS = Number.isFinite(parsedIdleThresholdHours) && parsedIdleThresholdHours >= 0
  ? parsedIdleThresholdHours
  : DEFAULT_PR_IDLE_THRESHOLD_HOURS;

const PR_IDLE_THRESHOLD_MS = PR_IDLE_THRESHOLD_HOURS * 60 * 60 * 1000;

export interface PullRequestLike {
  creationDate?: string | Date;
  lastMergeSourceCommit?: {
    commitId?: string;
    committer?: {
      date?: string | Date;
    };
  };
}

export function parseTimestamp(value: string | Date | undefined): number | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function getPrLastActivityTimestamp(pr: PullRequestLike): number | null {
  return parseTimestamp(pr.lastMergeSourceCommit?.committer?.date) ?? parseTimestamp(pr.creationDate);
}

export function getPrIdleAgeMs(pr: PullRequestLike, now = Date.now()): number | null {
  const timestamp = getPrLastActivityTimestamp(pr);
  if (timestamp === null) return null;
  return Math.max(0, now - timestamp);
}

export function isPrIdle(pr: PullRequestLike, now = Date.now()): boolean {
  const idleAgeMs = getPrIdleAgeMs(pr, now);
  return idleAgeMs !== null && idleAgeMs > PR_IDLE_THRESHOLD_MS;
}

export function formatPrIdleAge(pr: PullRequestLike, now = Date.now()): string {
  const idleAgeMs = getPrIdleAgeMs(pr, now);
  if (idleAgeMs === null) return "an unknown amount of time";

  const idleHours = idleAgeMs / (60 * 60 * 1000);
  if (idleHours >= 24) {
    return `${(idleHours / 24).toFixed(1)} days`;
  }

  return `${idleHours.toFixed(1)} hours`;
}