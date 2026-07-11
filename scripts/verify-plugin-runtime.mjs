import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  distributionPaths,
  repositoryRoot,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";

const versions = parseVersions(process.argv.slice(2));
verifyPluginDistribution({ root: repositoryRoot });

const paths = distributionPaths(repositoryRoot);
const compatibility = JSON.parse(readFileSync(paths.compatibility, "utf8"));
const recordedVersions = compatibility.probes.map(
  (probe) => probe.codexVersion,
);
const requestedVersions = versions.length > 0 ? versions : recordedVersions;
for (const version of requestedVersions) {
  if (!recordedVersions.includes(version)) {
    throw new Error(
      `Codex ${version} has no compatibility record; record a successful probe before verifying it`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "scripts", "plugin-runtime-probe.mjs"),
      "--codex-version",
      version,
      "--expect",
      paths.compatibility,
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
      timeout: 15 * 60_000,
    },
  );
  if (result.error) {
    throw new Error(
      `Plugin runtime probe for Codex ${version} failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Plugin runtime probe for Codex ${version} exited with ${result.status ?? "an unknown status"}`,
    );
  }
}

console.log(
  `plugin runtime verify ok: ${requestedVersions.join(", ")} matches the compatibility record`,
);

function parseVersions(args) {
  const parsed = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--codex-version") {
      throw new Error(
        "Usage: node scripts/verify-plugin-runtime.mjs [--codex-version VERSION]...",
      );
    }
    const version = args[index + 1];
    if (!version) {
      throw new Error("--codex-version requires a version");
    }
    parsed.push(version);
    index += 1;
  }
  return [...new Set(parsed)];
}
