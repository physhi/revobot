import * as fs from "fs";
import * as path from "path";

const PROJECT_ROOT = path.join(__dirname, "..");

/**
 * Resolves an MCP template file by substituting `{repo.*}` and `{env.*}` placeholders.
 *
 * - `{repo.orgUrl}` → value of `repo.orgUrl` from the repo config
 * - `{env.AZURE_DEVOPS_PAT}` → value of `process.env.AZURE_DEVOPS_PAT`
 *
 * Unresolved `{env.*}` placeholders (missing env vars) are replaced with empty string.
 * Unresolved `{repo.*}` placeholders are left as-is (likely a typo in the template).
 */
export function resolveMcpConfig(
  templateName: string,
  repo: Record<string, any>,
): string {
  const templatePath = path.join(PROJECT_ROOT, templateName);
  let content = fs.readFileSync(templatePath, "utf-8");

  // Replace {repo.*} placeholders
  content = content.replace(/\{repo\.(\w+)\}/g, (_match, key) => {
    return repo[key] !== undefined ? String(repo[key]) : _match;
  });

  // Replace {env.*} placeholders
  content = content.replace(/\{env\.([^}]+)\}/g, (_match, key) => {
    return process.env[key] ?? "";
  });

  return content;
}

/**
 * Resolves an MCP template and writes the result to a per-repo output file.
 * Returns the path to the resolved config file.
 *
 * Template: `.mcp-review.json` → Output: `.mcp-review-MCQdbDev.json`
 */
export function writeMcpConfig(
  templateName: string,
  repo: Record<string, any>,
): string {
  const resolved = resolveMcpConfig(templateName, repo);
  const ext = path.extname(templateName);
  const base = path.basename(templateName, ext);
  const outputName = `${base}-${repo.repository}${ext}`;
  const outputPath = path.join(PROJECT_ROOT, outputName);
  fs.writeFileSync(outputPath, resolved);
  return outputPath;
}
