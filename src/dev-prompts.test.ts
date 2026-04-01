import { describe, it, expect } from "vitest";
import { parseResultBlock, extractPrIdFallback } from "./dev-prompts";

describe("parseResultBlock", () => {
  const START = "=== DEV_DAEMON_RESULT ===";
  const END = "=== END DEV_DAEMON_RESULT ===";

  it("extracts key-value pairs from well-formed block", () => {
    const output = `Some output\n${START}\nstatus: success\npull_request_id: 42\nbranch: feature/test\n${END}\nMore output`;
    const result = parseResultBlock(output);
    expect(result).toEqual({
      status: "success",
      pull_request_id: "42",
      branch: "feature/test",
    });
  });

  it("returns null when start marker is missing", () => {
    expect(parseResultBlock("just some output without markers")).toBeNull();
  });

  it("returns null when end marker is missing", () => {
    expect(parseResultBlock(`${START}\nstatus: success\n`)).toBeNull();
  });

  it("returns null for empty block (markers present, no content)", () => {
    expect(parseResultBlock(`${START}\n\n${END}`)).toBeNull();
  });

  it("preserves values containing colons (e.g., URLs)", () => {
    const output = `${START}\nurl: https://dev.azure.com/org/project/_git/repo/pullrequest/42\nstatus: success\n${END}`;
    const result = parseResultBlock(output);
    expect(result).not.toBeNull();
    expect(result!.url).toBe("https://dev.azure.com/org/project/_git/repo/pullrequest/42");
    expect(result!.status).toBe("success");
  });

  it("skips lines without colons", () => {
    const output = `${START}\nstatus: success\nsome random text\npull_request_id: 10\n${END}`;
    const result = parseResultBlock(output);
    expect(result).toEqual({ status: "success", pull_request_id: "10" });
  });

  it("skips entries with empty values", () => {
    const output = `${START}\nstatus: success\nempty_key:   \n${END}`;
    const result = parseResultBlock(output);
    expect(result).toEqual({ status: "success" });
  });

  it("handles whitespace around keys and values", () => {
    const output = `${START}\n  status  :  success  \n  branch :  main  \n${END}`;
    const result = parseResultBlock(output);
    expect(result).toEqual({ status: "success", branch: "main" });
  });

  it("uses first result block when multiple exist", () => {
    const output = `${START}\nstatus: first\n${END}\n${START}\nstatus: second\n${END}`;
    const result = parseResultBlock(output);
    expect(result).toEqual({ status: "first" });
  });
});

describe("extractPrIdFallback", () => {
  it('extracts from "PR #42" format', () => {
    expect(extractPrIdFallback("Created PR #42 successfully")).toBe(42);
  });

  it('extracts from "pull request #42" format', () => {
    expect(extractPrIdFallback("Created pull request #42")).toBe(42);
  });

  it('extracts from "pull request 42" format (no hash)', () => {
    expect(extractPrIdFallback("Created pull request 42")).toBe(42);
  });

  it('extracts from "pullRequestId: 42" format', () => {
    expect(extractPrIdFallback("pullRequestId: 42")).toBe(42);
  });

  it('extracts from "pr_id: 42" format', () => {
    expect(extractPrIdFallback("pr_id: 42")).toBe(42);
  });

  it('extracts from "pull_request_id: 42" format', () => {
    expect(extractPrIdFallback("pull_request_id: 42")).toBe(42);
  });

  it("returns null when no PR ID found", () => {
    expect(extractPrIdFallback("No pull request created")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractPrIdFallback("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractPrIdFallback("pr #99")).toBe(99);
    expect(extractPrIdFallback("PULL REQUEST #100")).toBe(100);
  });

  it("returns first match when multiple exist", () => {
    expect(extractPrIdFallback("Created PR #10, then updated PR #20")).toBe(10);
  });
});
