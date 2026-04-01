import { describe, it, expect } from "vitest";
import {
  isWipState,
  countWipItems,
  createDefaultWorkItemState,
  DevLifecycleState,
  DevStateFile,
} from "./dev-state";

describe("isWipState", () => {
  const wipStates: DevLifecycleState[] = ["needs_plan", "plan_approved", "implementing", "pr_babysitting"];
  const nonWipStates: DevLifecycleState[] = ["discovered", "completed", "abandoned"];

  for (const state of wipStates) {
    it(`returns true for "${state}"`, () => {
      expect(isWipState(state)).toBe(true);
    });
  }

  for (const state of nonWipStates) {
    it(`returns false for "${state}"`, () => {
      expect(isWipState(state)).toBe(false);
    });
  }
});

describe("countWipItems", () => {
  it("returns 0 for empty items", () => {
    const state: DevStateFile = { version: 1, lastDiscoveryAt: null, items: {} };
    expect(countWipItems(state)).toBe(0);
  });

  it("counts only WIP states", () => {
    const state: DevStateFile = {
      version: 1,
      lastDiscoveryAt: null,
      items: {
        "1": createDefaultWorkItemState(1, "test1", "/tmp/1"),
        "2": { ...createDefaultWorkItemState(2, "test2", "/tmp/2"), state: "implementing" },
        "3": { ...createDefaultWorkItemState(3, "test3", "/tmp/3"), state: "completed" },
        "4": { ...createDefaultWorkItemState(4, "test4", "/tmp/4"), state: "pr_babysitting" },
        "5": { ...createDefaultWorkItemState(5, "test5", "/tmp/5"), state: "abandoned" },
      },
    };
    // discovered=1(not WIP), implementing=2(WIP), completed=3(not WIP), pr_babysitting=4(WIP), abandoned=5(not WIP)
    expect(countWipItems(state)).toBe(2);
  });

  it("counts all WIP states correctly", () => {
    const state: DevStateFile = {
      version: 1,
      lastDiscoveryAt: null,
      items: {
        "1": { ...createDefaultWorkItemState(1, "t", "/tmp"), state: "needs_plan" },
        "2": { ...createDefaultWorkItemState(2, "t", "/tmp"), state: "plan_approved" },
        "3": { ...createDefaultWorkItemState(3, "t", "/tmp"), state: "implementing" },
        "4": { ...createDefaultWorkItemState(4, "t", "/tmp"), state: "pr_babysitting" },
      },
    };
    expect(countWipItems(state)).toBe(4);
  });
});

describe("createDefaultWorkItemState", () => {
  it("creates state with correct defaults", () => {
    const state = createDefaultWorkItemState(123, "Test Item", "/tmp/worktree");

    expect(state.workItemId).toBe(123);
    expect(state.title).toBe("Test Item");
    expect(state.state).toBe("discovered");
    expect(state.worktreePath).toBe("/tmp/worktree");

    // Counters start at zero
    expect(state.implementationAttempts).toBe(0);
    expect(state.babysitInvocations).toBe(0);
    expect(state.babysitConsecutiveFailures).toBe(0);
    expect(state.babysitSessionTurnCount).toBe(0);
    expect(state.lastWiCommentCount).toBe(0);
    expect(state.lastPrThreadCount).toBe(0);
    expect(state.lastPrCommentCount).toBe(0);

    // Nullable fields start null
    expect(state.branchName).toBeNull();
    expect(state.pullRequestId).toBeNull();
    expect(state.lastClaudeSessionId).toBeNull();
    expect(state.contextFilePath).toBeNull();
    expect(state.planSessionId).toBeNull();
    expect(state.implSessionId).toBeNull();
    expect(state.babysitSessionId).toBeNull();
    expect(state.backoffUntil).toBeNull();

    // Worktree starts as missing
    expect(state.worktreeStatus).toBe("missing");
  });

  it("sets discoveredAt and updatedAt to current time", () => {
    const before = new Date().toISOString();
    const state = createDefaultWorkItemState(1, "t", "/tmp");
    const after = new Date().toISOString();

    expect(state.discoveredAt >= before).toBe(true);
    expect(state.discoveredAt <= after).toBe(true);
    expect(state.updatedAt).toBe(state.discoveredAt);
  });
});
