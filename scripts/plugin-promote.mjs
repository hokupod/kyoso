import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPluginMcpArgs,
  distributionPaths,
  repositoryRoot,
  transformCanonicalToPlugin,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";
import { verifyPublishedCliTarget } from "./verify-published-cli.mjs";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

async function main() {
  await runPluginPromotion(parseOptions(process.argv.slice(2)));
}

export async function runPluginPromotion(
  options,
  {
    root = repositoryRoot,
    verifyDistribution = verifyPluginDistribution,
    verifyPublished = verifyPublishedCliTarget,
    createPromotionUpdates = createUpdates,
    writePromotionUpdates = writeUpdatesAtomically,
    restorePromotionUpdates = restoreCommittedUpdates,
    log = console.log,
  } = {},
) {
  assertPromotionOptions(options);
  const current = verifyDistribution({ root, verifyPackageArchive: false });
  const packageMetadata = readJson(join(root, "package.json"));
  if (packageMetadata.version !== options.cliVersion) {
    throw new Error(
      `package.json version (${packageMetadata.version}) must match --cli-version (${options.cliVersion}) before Plugin promotion`,
    );
  }
  assertPromotionAdvances(current, options);

  const requested = await verifyPublished({
    packageName: current.packageName,
    packageVersion: options.cliVersion,
  });
  const updates = createPromotionUpdates(options, root);

  if (!options.write) {
    log("plugin promotion dry-run (no files changed)");
    printUpdates(updates, root, log);
    log(
      `published CLI runtime verified: ${requested ?? `${current.packageName}@${options.cliVersion}`}\nnext: rerun with --write, then plugin:verify:registry and plugin:runtime:verify`,
    );
    return { action: "dry-run", requested, updates };
  }

  let written;
  try {
    written = writePromotionUpdates(updates);
  } catch (error) {
    throw new Error(`Plugin promotion write failed: ${errorMessage(error)}`);
  }

  const committed = written?.committed ?? written;
  if (!Array.isArray(committed)) {
    throw new Error("Plugin promotion write did not report committed entries");
  }
  try {
    if (written?.cleanupFailures?.length > 0) {
      throw new Error(
        `Plugin promotion temporary cleanup failed: ${written.cleanupFailures.join(
          "; ",
        )}`,
      );
    }
    verifyDistribution({
      root,
      verifyPackageArchive: false,
      expectedPackageVersion: options.cliVersion,
    });
  } catch (verificationError) {
    let rollbackError;
    try {
      restorePromotionUpdates(committed);
      verifyDistribution({ root, verifyPackageArchive: false });
    } catch (error) {
      rollbackError = error;
    }
    if (rollbackError) {
      throw new Error(
        `Plugin promotion post-write verification failed: ${errorMessage(verificationError)}; rollback failed: ${errorMessage(rollbackError)}`,
      );
    }
    throw new Error(
      `Plugin promotion post-write verification failed and original distribution was restored: ${errorMessage(verificationError)}`,
    );
  }

  log(
    `plugin promotion updated after verifying ${requested ?? `${current.packageName}@${options.cliVersion}`}`,
  );
  printUpdates(updates, root, log);
  log(
    "next: run plugin:verify, plugin:verify:registry, and plugin:runtime:verify before opening the Plugin promotion change",
  );
  return { action: "updated", requested, updates, committed };
}

export function assertPromotionAdvances(current, options) {
  if (compareSemver(options.cliVersion, current.packageVersion) <= 0) {
    throw new Error(
      `Plugin promotion CLI version (${options.cliVersion}) must advance the current MCP pin (${current.packageVersion})`,
    );
  }
  if (compareSemver(options.pluginVersion, current.pluginVersion) <= 0) {
    throw new Error(
      `Plugin promotion version (${options.pluginVersion}) must advance the current Plugin version (${current.pluginVersion})`,
    );
  }
}

export function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);
  for (const field of ["major", "minor", "patch"]) {
    if (leftParts[field] !== rightParts[field]) {
      return leftParts[field] > rightParts[field] ? 1 : -1;
    }
  }
  if (!leftParts.prerelease && !rightParts.prerelease) return 0;
  if (!leftParts.prerelease) return 1;
  if (!rightParts.prerelease) return -1;
  const length = Math.max(
    leftParts.prerelease.length,
    rightParts.prerelease.length,
  );
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts.prerelease[index];
    const rightPart = rightParts.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) > Number(rightPart) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function createUpdates(
  { cliVersion, pluginVersion },
  root = repositoryRoot,
) {
  const paths = distributionPaths(root);
  const packagePin = `@kyo-so/cli@${cliVersion}`;
  const mcp = readJson(paths.mcp);
  const manifest = readJson(paths.manifest);
  const claudeManifest = readJson(paths.claudeManifest);
  const claudeMarketplace = readJson(paths.claudeMarketplace);
  const compatibility = readJson(paths.compatibility);
  const runtimeContract = readFileSync(paths.runtimeContract, "utf8");
  const pluginSkillInstructions = transformCanonicalToPlugin(
    "SKILL.md",
    readFileSync(join(paths.canonicalSkill, "SKILL.md")),
    packagePin,
  ).toString("utf8");

  mcp.kyoso.args = buildPluginMcpArgs(packagePin);
  manifest.version = pluginVersion;
  claudeManifest.version = pluginVersion;
  claudeManifest.mcpServers.kyoso.args = buildPluginMcpArgs(packagePin);
  claudeMarketplace.plugins[0].version = pluginVersion;
  claudeMarketplace.metadata.version = pluginVersion;
  compatibility.expectedContract.distribution.mcpPackagePin = packagePin;
  compatibility.expectedContract.distribution.pluginVersion = pluginVersion;
  const updatedRuntimeContract = replaceRuntimeContractValues(
    runtimeContract,
    packagePin,
    pluginVersion,
  );

  return [
    update(paths.mcp, JSON.stringify(mcp, null, 2) + "\n"),
    update(paths.manifest, JSON.stringify(manifest, null, 2) + "\n"),
    update(paths.compatibility, JSON.stringify(compatibility, null, 2) + "\n"),
    update(paths.runtimeContract, updatedRuntimeContract),
    update(join(paths.pluginSkill, "SKILL.md"), pluginSkillInstructions),
    update(
      paths.claudeManifest,
      JSON.stringify(claudeManifest, null, 2) + "\n",
    ),
    update(
      paths.claudeMarketplace,
      JSON.stringify(claudeMarketplace, null, 2) + "\n",
    ),
  ];
}

export function writeUpdatesAtomically(updates, options = {}) {
  const removeTemporary = options.removeTemporary ?? removeTemporaryFile;
  const staged = [];
  try {
    for (const entry of updates) {
      assertPromotionTargetUnchanged(entry);
      const temporary = temporaryPath(entry.path, "plugin-promote");
      staged.push({ ...entry, temporary });
      writeExclusiveAndFlush(temporary, entry.next, entry.mode);
    }
  } catch (error) {
    const cleanupFailures = cleanupTemporaryEntries(staged, removeTemporary);
    throw appendCleanupFailures(error, cleanupFailures);
  }

  const committed = [];
  try {
    for (const entry of staged) {
      renameSync(entry.temporary, entry.path);
      committed.push(entry);
    }
  } catch (error) {
    let rollbackError;
    try {
      restoreCommittedUpdates(committed);
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    const cleanupFailures = cleanupTemporaryEntries(staged, removeTemporary);
    throw new Error(
      `Plugin promotion rename failed: ${errorMessage(error)}${rollbackError ? `; rollback failed: ${errorMessage(rollbackError)}` : "; committed files were restored"}${formatCleanupFailures(cleanupFailures)}`,
    );
  }
  return {
    committed,
    cleanupFailures: cleanupTemporaryEntries(staged, removeTemporary),
  };
}

export function restoreCommittedUpdates(committed, options = {}) {
  const failures = [];
  const removeTemporary = options.removeTemporary ?? removeTemporaryFile;
  for (const entry of [...committed].reverse()) {
    const temporary = temporaryPath(entry.path, "plugin-rollback");
    try {
      options.beforeRestoreEntry?.(entry);
      writeExclusiveAndFlush(temporary, entry.current, entry.mode);
      renameSync(temporary, entry.path);
    } catch (error) {
      failures.push(`${entry.path}: ${errorMessage(error)}`);
    } finally {
      try {
        removeTemporary(temporary);
      } catch (error) {
        failures.push(
          `${entry.path}: could not remove rollback temporary file: ${errorMessage(error)}`,
        );
      }
    }
  }
  for (const entry of committed) {
    try {
      assertEntryMatchesOriginal(entry);
    } catch (error) {
      failures.push(`${entry.path}: ${errorMessage(error)}`);
    }
    try {
      const temporaryPrefix = `.${basename(entry.path)}.plugin-`;
      const leftover = readdirSync(dirname(entry.path)).filter((name) =>
        name.startsWith(temporaryPrefix),
      );
      if (leftover.length > 0) {
        failures.push(
          `${entry.path}: temporary files remain: ${leftover.join(", ")}`,
        );
      }
    } catch (error) {
      failures.push(
        `${entry.path}: could not inspect temporary files: ${errorMessage(error)}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Plugin promotion rollback failed for paths: ${failures.join("; ")}`,
    );
  }
}

function update(path, next) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Promotion target must be a regular file: ${path}`);
  }
  return {
    path,
    current: readFileSync(path),
    next,
    mode: stat.mode & 0o777,
  };
}

function assertPromotionTargetUnchanged(entry) {
  const stat = lstatSync(entry.path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Promotion target must be a regular file: ${entry.path}`);
  }
  if ((stat.mode & 0o777) !== entry.mode) {
    throw new Error(
      `Promotion target mode changed before write: ${entry.path}`,
    );
  }
  if (!readFileSync(entry.path).equals(Buffer.from(entry.current))) {
    throw new Error(
      `Promotion target bytes changed before write: ${entry.path}`,
    );
  }
}

function assertEntryMatchesOriginal(entry) {
  const stat = lstatSync(entry.path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("target is no longer a regular file");
  }
  if ((stat.mode & 0o777) !== entry.mode) {
    throw new Error("original mode was not restored");
  }
  if (!readFileSync(entry.path).equals(Buffer.from(entry.current))) {
    throw new Error("original bytes were not restored");
  }
}

function temporaryPath(path, purpose) {
  return join(dirname(path), `.${basename(path)}.${purpose}-${randomUUID()}`);
}

function writeExclusiveAndFlush(path, contents, mode) {
  const descriptor = openSync(path, "wx", mode);
  try {
    fchmodSync(descriptor, mode);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function cleanupTemporaryEntries(
  entries,
  removeTemporary = removeTemporaryFile,
) {
  const failures = [];
  for (const entry of entries) {
    if (!entry.temporary) continue;
    try {
      removeTemporary(entry.temporary);
    } catch (error) {
      failures.push(`${entry.temporary}: ${errorMessage(error)}`);
    }
  }
  return failures;
}

function removeTemporaryFile(path) {
  rmSync(path, { force: true });
}

function appendCleanupFailures(error, cleanupFailures) {
  if (cleanupFailures.length === 0) return error;
  return new Error(
    `${errorMessage(error)}; temporary cleanup failed: ${cleanupFailures.join("; ")}`,
  );
}

function formatCleanupFailures(cleanupFailures) {
  return cleanupFailures.length > 0
    ? `; temporary cleanup failed: ${cleanupFailures.join("; ")}`
    : "";
}

function replaceRuntimeContractValues(source, packagePin, pluginVersion) {
  const marker = "export const PLUGIN_RUNTIME_EXPECTED_CONTRACT =";
  const start = source.indexOf(marker);
  const end = source.indexOf("} as const;", start);
  if (start === -1 || end === -1) {
    throw new Error("Could not locate PLUGIN_RUNTIME_EXPECTED_CONTRACT");
  }
  const contract = source.slice(start, end + "} as const;".length);
  const updated = replaceContractString(
    replaceContractString(contract, "mcpPackagePin", packagePin),
    "pluginVersion",
    pluginVersion,
  );
  return `${source.slice(0, start)}${updated}${source.slice(end + "} as const;".length)}`;
}

function replaceContractString(contract, field, value) {
  const pattern = new RegExp(`(\\b${field}:\\s*)["'][^"']*["']`);
  if (!pattern.test(contract)) {
    throw new Error(
      `Could not locate ${field} in PLUGIN_RUNTIME_EXPECTED_CONTRACT`,
    );
  }
  return contract.replace(pattern, `$1${JSON.stringify(value)}`);
}

function printUpdates(updates, root, log) {
  for (const entry of updates) {
    log(
      `  ${relative(root, entry.path)}: ${Buffer.from(entry.current).equals(Buffer.from(entry.next)) ? "unchanged" : "update"}`,
    );
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function parseOptions(args) {
  const parsed = { write: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--write") {
      parsed.write = true;
      continue;
    }
    if (argument === "--cli-version" || argument === "--plugin-version") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--cli-version") parsed.cliVersion = value;
      if (argument === "--plugin-version") parsed.pluginVersion = value;
      continue;
    }
    throw new Error(
      "Usage: node scripts/plugin-promote.mjs --cli-version VERSION --plugin-version VERSION [--write]",
    );
  }
  assertPromotionOptions(parsed);
  return parsed;
}

function assertPromotionOptions(options) {
  if (!semverPattern.test(options?.cliVersion ?? "")) {
    throw new Error("--cli-version must be a complete SemVer version");
  }
  if (!semverPattern.test(options?.pluginVersion ?? "")) {
    throw new Error("--plugin-version must be a complete SemVer version");
  }
  if (typeof options.write !== "boolean") {
    throw new Error("Plugin promotion write option must be boolean");
  }
}

function parseSemver(version) {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!match) throw new Error(`Invalid SemVer version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split("."),
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
