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

  let publishedVersion;
  try {
    publishedVersion = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `npm view ${requested} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (publishedVersion !== packageVersion) {
    throw new Error(
      `npm registry returned ${JSON.stringify(publishedVersion)} for ${requested}; expected ${packageVersion}`,
    );
  }

  return requested;
}
