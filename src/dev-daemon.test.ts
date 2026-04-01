import { describe, it, expect } from "vitest";
import { matchesApprovalKeyword, shouldInvokeBabysit } from "./dev-daemon";
import { createDefaultWorkItemState } from "./dev-state";

describe("matchesApprovalKeyword", () => {
  // Positive matches — whole word, no negation
  it('matches "approved" as a whole word', () => {
    expect(matchesApprovalKeyword("this looks good, approved")).not.toBeNull();
  });

  it('matches "go ahead" as a phrase', () => {
    expect(matchesApprovalKeyword("yes go ahead with this")).not.toBeNull();
  });

  it('matches "lgtm"', () => {
    expect(matchesApprovalKeyword("lgtm, ship it")).not.toBeNull();
  });

  it('matches "ship it"', () => {
    expect(matchesApprovalKeyword("looks great, ship it")).not.toBeNull();
  });

  it('matches "proceed"', () => {
    expect(matchesApprovalKeyword("please proceed with implementation")).not.toBeNull();
  });

  it("is case-insensitive", () => {
    expect(matchesApprovalKeyword("APPROVED")).not.toBeNull();
    expect(matchesApprovalKeyword("Go Ahead")).not.toBeNull();
  });

  // False positive prevention — negations
  it('rejects "not approved"', () => {
    expect(matchesApprovalKeyword("this is not approved")).toBeNull();
  });

  it("rejects \"don't proceed\"", () => {
    expect(matchesApprovalKeyword("don't proceed with this")).toBeNull();
  });

  it("rejects \"do not go ahead\"", () => {
    expect(matchesApprovalKeyword("do not go ahead")).toBeNull();
  });

  it("rejects \"don't do it\"", () => {
    expect(matchesApprovalKeyword("don't do it yet")).toBeNull();
  });

  it("rejects \"cannot approve\"", () => {
    expect(matchesApprovalKeyword("i cannot approve this")).toBeNull();
  });

  // False positive prevention — substrings
  it('does not match "yesterday" for keyword "yes"', () => {
    expect(matchesApprovalKeyword("yesterday i reviewed the code")).toBeNull();
  });

  it('does not match "proceeding" for keyword "proceed"', () => {
    expect(matchesApprovalKeyword("we are proceeding carefully")).toBeNull();
  });

  // No match at all
  it("returns null when no keywords present", () => {
    expect(matchesApprovalKeyword("this needs more review")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(matchesApprovalKeyword("")).toBeNull();
  });
});

describe("shouldInvokeBabysit", () => {
  const changedResult = {
    prStatus: "active" as const,
    threadChanged: true,
    buildChanged: false,
    commentChanged: false,
    newThreadCount: 5,
    newCommentCount: 10,
    newBuildResultId: "build-1",
    newBuildStatus: "succeeded",
    latestActivityAt: null,
  };

  const noChangesResult = {
    ...changedResult,
    threadChanged: false,
    buildChanged: false,
    commentChanged: false,
  };

  function makeState(overrides: Record<string, any> = {}) {
    const base = createDefaultWorkItemState(1, "test", "/tmp");
    return {
      ...base,
      state: "pr_babysitting" as const,
      lastBabysitCheckAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago (past interval)
      babysitInvocations: 0,
      babysitStartedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("returns true when all gates pass", () => {
    expect(shouldInvokeBabysit(makeState(), changedResult, Date.now())).toBe(true);
  });

  it("returns false when interval not elapsed", () => {
    const state = makeState({
      lastBabysitCheckAt: new Date().toISOString(), // just now
    });
    expect(shouldInvokeBabysit(state, changedResult, Date.now())).toBe(false);
  });

  it("returns false when max invocations reached", () => {
    const state = makeState({ babysitInvocations: 20 });
    expect(shouldInvokeBabysit(state, changedResult, Date.now())).toBe(false);
  });

  it("returns false when timeout exceeded (72h)", () => {
    const state = makeState({
      babysitStartedAt: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(), // 73h ago
    });
    expect(shouldInvokeBabysit(state, changedResult, Date.now())).toBe(false);
  });

  it("returns false when no changes detected", () => {
    expect(shouldInvokeBabysit(makeState(), noChangesResult, Date.now())).toBe(false);
  });

  it("passes interval gate when lastBabysitCheckAt is null (first check)", () => {
    const state = makeState({ lastBabysitCheckAt: null });
    expect(shouldInvokeBabysit(state, changedResult, Date.now())).toBe(true);
  });

  it("passes timeout gate when babysitStartedAt is null", () => {
    const state = makeState({ babysitStartedAt: null });
    expect(shouldInvokeBabysit(state, changedResult, Date.now())).toBe(true);
  });
});
