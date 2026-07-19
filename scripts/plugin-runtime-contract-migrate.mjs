import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  distributionPaths,
  readBundledPluginRuntimeContract,
  repositoryRoot,
} from "./plugin-distribution.mjs";

const fixtureSchemaVersion = 2;

export async function migratePluginRuntimeContract(
  options = {},
  dependencies = {},
) {
  const root = options.root ?? repositoryRoot;
  const write = options.write ?? false;
  const paths = distributionPaths(root);
  const recordPath = options.recordPath ?? paths.compatibility;
  const bundled =
    dependencies.readBundledContract?.(root) ??
    readBundledPluginRuntimeContract(root);
  const runProbe = dependencies.runProbe ?? runPluginRuntimeProbe;
  const syncRecordDirectory = dependencies.syncDirectory ?? syncDirectory;
  const originalBytes = await readFile(recordPath);
  const originalHash = sha256(originalBytes);
  const original = parseRecord(originalBytes, recordPath);
  const versions = recordedVersions(original, recordPath);
  const sourceMinimumVersion = original.minimumSupportedCodexVersion;
  if (!isNonEmptyString(sourceMinimumVersion)) {
    throw new Error(
      "Plugin runtime compatibility minimumSupportedCodexVersion must be a non-empty string",
    );
  }
  if (!versions.includes(sourceMinimumVersion)) {
    throw new Error(
      "Plugin runtime compatibility minimumSupportedCodexVersion must be a recorded version",
    );
  }
  if (!isNonEmptyString(bundled.minimumSupportedCodexVersion)) {
    throw new Error(
      "Bundled Plugin runtime contract minimumSupportedCodexVersion must be a non-empty string",
    );
  }
  if (bundled.minimumSupportedCodexVersion !== sourceMinimumVersion) {
    throw new Error(
      "Bundled Plugin runtime contract minimumSupportedCodexVersion does not match the compatibility record",
    );
  }

  const sourceMode = (await stat(recordPath)).mode & 0o777;
  const candidatePath = join(
    dirname(recordPath),
    `.${basename(recordPath)}.kyoso-runtime-${process.pid}-${randomUUID()}.tmp`,
  );
  let committed = false;
  try {
    await writeExclusiveJson(
      candidatePath,
      {
        schemaVersion: bundled.schemaVersion,
        minimumSupportedCodexVersion: bundled.minimumSupportedCodexVersion,
        expectedContract: bundled.expectedContract,
        probes: [],
      },
      sourceMode,
    );

    for (const version of versions) {
      await runProbe({ root, version, recordPath: candidatePath });
    }
    await dependencies.afterProbes?.({ recordPath, candidatePath, versions });

    const candidateBytes = await readFile(candidatePath);
    const candidate = parseRecord(candidateBytes, candidatePath);
    validateCandidate({
      candidate,
      bundled,
      sourceVersions: versions,
    });

    if (!write) {
      return {
        action: "dry-run",
        recordPath,
        schemaVersion: bundled.schemaVersion,
        versions,
      };
    }

    const latestBytes = await readFile(recordPath);
    if (
      !latestBytes.equals(originalBytes) ||
      sha256(latestBytes) !== originalHash
    ) {
      throw new Error(
        "Plugin runtime compatibility record changed during migration; it was not overwritten",
      );
    }
    await flushPath(candidatePath);
    await syncRecordDirectory(dirname(recordPath));
    await rename(candidatePath, recordPath);
    committed = true;

    return {
      action: "updated",
      recordPath,
      schemaVersion: bundled.schemaVersion,
      versions,
    };
  } finally {
    if (!committed) {
      await rm(candidatePath, { force: true });
    }
  }
}

export function runPluginRuntimeProbe({ root, version, recordPath }) {
  const result = spawnSync(
    process.execPath,
    [
      join(root, "scripts", "plugin-runtime-probe.mjs"),
      "--codex-version",
      version,
      "--record",
      recordPath,
    ],
    {
      cwd: root,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
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
      `Plugin runtime probe for Codex ${version} exited with ${result.status ?? "an unknown status"}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function parseRecord(bytes, path) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Plugin runtime compatibility record could not be parsed at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function recordedVersions(record, path) {
  if (!Array.isArray(record.probes) || record.probes.length === 0) {
    throw new Error(
      `Plugin runtime compatibility record has no probes: ${path}`,
    );
  }
  const versions = record.probes.map((probe) => probe?.codexVersion);
  if (!versions.every(isNonEmptyString)) {
    throw new Error(
      `Plugin runtime compatibility record has an invalid Codex version: ${path}`,
    );
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error(
      `Plugin runtime compatibility record has duplicate Codex versions: ${path}`,
    );
  }
  return [...versions].sort((left, right) => left.localeCompare(right));
}

function validateCandidate({ candidate, bundled, sourceVersions }) {
  if (candidate.schemaVersion !== bundled.schemaVersion) {
    throw new Error(
      "Plugin runtime migration candidate schemaVersion does not match the bundled contract",
    );
  }
  if (
    candidate.minimumSupportedCodexVersion !==
    bundled.minimumSupportedCodexVersion
  ) {
    throw new Error(
      "Plugin runtime migration candidate minimumSupportedCodexVersion does not match the bundled contract",
    );
  }
  if (
    !isDeepStrictEqual(candidate.expectedContract, bundled.expectedContract)
  ) {
    throw new Error(
      "Plugin runtime migration candidate contract does not match the bundled contract",
    );
  }
  const candidateVersions = recordedVersions(candidate, "candidate");
  if (!sameStrings(candidateVersions, sourceVersions)) {
    throw new Error(
      "Plugin runtime migration candidate Codex version set does not match the source record",
    );
  }
  if (!candidateVersions.includes(candidate.minimumSupportedCodexVersion)) {
    throw new Error(
      "Plugin runtime migration candidate minimumSupportedCodexVersion is not recorded",
    );
  }
  if (
    !candidate.probes.every(
      (probe) => probe.fixtureSchemaVersion === fixtureSchemaVersion,
    )
  ) {
    throw new Error(
      `Plugin runtime migration candidate probes must all use fixtureSchemaVersion ${fixtureSchemaVersion}`,
    );
  }
}

function sameStrings(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

async function writeExclusiveJson(path, value, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function flushPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) return;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySyncError(error) {
  const code = error?.code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    (process.platform === "win32" && code === "EPERM")
  );
}

function parseOptions(args) {
  if (args.length === 0) return { write: false };
  if (args.length === 1 && args[0] === "--write") return { write: true };
  throw new Error(
    "Usage: node scripts/plugin-runtime-contract-migrate.mjs [--write]",
  );
}

async function main() {
  const result = await migratePluginRuntimeContract(
    parseOptions(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
