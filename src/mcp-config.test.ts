import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveMcpConfig, writeMcpConfig } from "./mcp-config";

const PROJECT_ROOT = path.join(__dirname, "..");

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn() };
});

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

const REPO = {
  name: "Dev",
  orgUrl: "https://dev.azure.com/myorg",
  project: "MyProject",
  repository: "MyRepo",
  localPath: "b:/repos/MyRepo",
  worktreeCount: 2,
  enabled: true,
};

describe("resolveMcpConfig", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("substitutes {repo.*} placeholders from the repo config", () => {
    mockReadFileSync.mockReturnValue(
      '{"org": "{repo.orgUrl}", "proj": "{repo.project}", "repo": "{repo.repository}"}'
    );

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe('{"org": "https://dev.azure.com/myorg", "proj": "MyProject", "repo": "MyRepo"}');
  });

  it("substitutes {env.*} placeholders from process.env", () => {
    const origPat = process.env.AZURE_DEVOPS_PAT;
    process.env.AZURE_DEVOPS_PAT = "secret-pat-value";

    mockReadFileSync.mockReturnValue('{"pat": "{env.AZURE_DEVOPS_PAT}"}');

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe('{"pat": "secret-pat-value"}');

    if (origPat === undefined) delete process.env.AZURE_DEVOPS_PAT;
    else process.env.AZURE_DEVOPS_PAT = origPat;
  });

  it("replaces missing env vars with empty string", () => {
    const key = "MCP_TEST_NONEXISTENT_VAR_12345";
    delete process.env[key];

    mockReadFileSync.mockReturnValue(`{"val": "{env.${key}}"}`);

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe('{"val": ""}');
  });

  it("leaves unresolved {repo.*} placeholders as-is for unknown keys", () => {
    mockReadFileSync.mockReturnValue('{"x": "{repo.nonExistentKey}"}');

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe('{"x": "{repo.nonExistentKey}"}');
  });

  it("handles mixed repo and env placeholders in one template", () => {
    const origPat = process.env.AZURE_DEVOPS_PAT;
    process.env.AZURE_DEVOPS_PAT = "my-pat";

    mockReadFileSync.mockReturnValue(
      '{"org": "{repo.orgUrl}", "pat": "{env.AZURE_DEVOPS_PAT}", "name": "{repo.name}"}'
    );

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe(
      '{"org": "https://dev.azure.com/myorg", "pat": "my-pat", "name": "Dev"}'
    );

    if (origPat === undefined) delete process.env.AZURE_DEVOPS_PAT;
    else process.env.AZURE_DEVOPS_PAT = origPat;
  });

  it("leaves literal text and non-placeholder braces untouched", () => {
    mockReadFileSync.mockReturnValue('{"static": "hello", "braces": "{notANamespace}"}');

    const result = resolveMcpConfig(".mcp-test.json", REPO);
    expect(result).toBe('{"static": "hello", "braces": "{notANamespace}"}');
  });

  it("reads from the correct template path", () => {
    mockReadFileSync.mockReturnValue("{}");

    resolveMcpConfig(".mcp-review.json", REPO);
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join(PROJECT_ROOT, ".mcp-review.json"),
      "utf-8",
    );
  });
});

describe("writeMcpConfig", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("writes resolved content to per-repo output file", () => {
    mockReadFileSync.mockReturnValue('{"repo": "{repo.repository}"}');

    const result = writeMcpConfig(".mcp-review.json", REPO);

    expect(result).toBe(path.join(PROJECT_ROOT, ".mcp-review-MyRepo.json"));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      path.join(PROJECT_ROOT, ".mcp-review-MyRepo.json"),
      '{"repo": "MyRepo"}',
    );
  });

  it("uses correct naming for dev template", () => {
    mockReadFileSync.mockReturnValue("{}");

    const result = writeMcpConfig(".mcp-dev.json", REPO);

    expect(result).toBe(path.join(PROJECT_ROOT, ".mcp-dev-MyRepo.json"));
  });

  it("returns the resolved output path", () => {
    mockReadFileSync.mockReturnValue("{}");

    const result = writeMcpConfig(".mcp-review.json", REPO);
    expect(typeof result).toBe("string");
    expect(result).toContain(".mcp-review-MyRepo.json");
  });
});
