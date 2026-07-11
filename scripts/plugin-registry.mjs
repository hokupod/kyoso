import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assertPublishedCliVersion({
  packageName,
  packageVersion,
  cwd,
}) {
  const requested = `${packageName}@${packageVersion}`;
  const cacheRoot = mkdtempSync(join(tmpdir(), "kyoso-plugin-registry-"));
  let result;
  try {
    result = spawnSync(
      "npm",
      [
        "--cache",
        join(cacheRoot, "npm-cache"),
        "view",
        requested,
        "version",
        "--json",
      ],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      },
    );
  } finally {
    rmSync(cacheRoot, { force: true, recursive: true });
  }

  if (result?.error) {
    throw new Error(`npm view ${requested} failed: ${result.error.message}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `npm view ${requested} failed (${result?.status ?? "unknown"}): ${(result?.stderr || result?.stdout || "").trim()}`,
    );
  }

  // npm's stdout is unreliable under interposing shims (safe-chain in CI
  // appends its own lines), so look for a line that is exactly the expected
  // version instead of JSON-parsing the whole payload.
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const matched = lines.some(
    (line) => line === packageVersion || line === `"${packageVersion}"`,
  );
  if (!matched) {
    throw new Error(
      `npm registry did not confirm ${requested}; expected version ${packageVersion} in output: ${lines.join(" | ").slice(0, 300)}`,
    );
  }

  return requested;
}
