import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  distributionPaths,
  repositoryRoot,
  transformCanonicalToPlugin,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";
import { assertPublishedCliVersion } from "./plugin-registry.mjs";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  await main();
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!semverPattern.test(options.cliVersion)) {
    throw new Error("--cli-version must be a complete SemVer version");
  }
  if (!semverPattern.test(options.pluginVersion)) {
    throw new Error("--plugin-version must be a complete SemVer version");
  }

  const current = verifyPluginDistribution({
    root: repositoryRoot,
    verifyPackageArchive: false,
  });
  const packageMetadata = readJson(join(repositoryRoot, "package.json"));
  if (packageMetadata.version !== options.cliVersion) {
    throw new Error(
      `package.json version (${packageMetadata.version}) must match --cli-version (${options.cliVersion}) before Plugin promotion`,
    );
  }
  assertPromotionAdvances(current, options);

  const requested = await assertPublishedCliVersion({
    packageName: current.packageName,
    packageVersion: options.cliVersion,
  });
  const updates = createUpdates(options);

  if (!options.write) {
    console.log("plugin promotion dry-run (no files changed)");
    printUpdates(updates);
    console.log(
      `published CLI confirmed: ${requested}\nnext: rerun with --write, then plugin:verify:registry and plugin:runtime:verify`,
    );
    return;
  }

  writeUpdatesAtomically(updates);
  verifyPluginDistribution({
    root: repositoryRoot,
    verifyPackageArchive: false,
    expectedPackageVersion: options.cliVersion,
  });
  console.log(`plugin promotion updated after confirming ${requested}`);
  printUpdates(updates);
  console.log(
    "next: run plugin:verify, plugin:verify:registry, and plugin:runtime:verify before opening the Plugin promotion change",
  );
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

  mcp.kyoso.args[1] = packagePin;
  manifest.version = pluginVersion;
  claudeManifest.version = pluginVersion;
  claudeManifest.mcpServers.kyoso.args[1] = packagePin;
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

function update(path, next) {
  return { path, current: readFileSync(path, "utf8"), next };
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

function writeUpdatesAtomically(updates) {
  const staged = [];
  try {
    for (const entry of updates) {
      const stat = lstatSync(entry.path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `Promotion target must be a regular file: ${entry.path}`,
        );
      }
      const temporary = join(
        dirname(entry.path),
        `.${basename(entry.path)}.plugin-promote-${randomUUID()}`,
      );
      writeFileSync(temporary, entry.next, {
        encoding: "utf8",
        mode: statSync(entry.path).mode & 0o777,
      });
      staged.push({ ...entry, temporary });
    }
  } catch (error) {
    for (const entry of staged) {
      rmSync(entry.temporary, { force: true });
    }
    throw error;
  }
  const committed = [];
  try {
    for (const entry of staged) {
      renameSync(entry.temporary, entry.path);
      committed.push(entry);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const entry of committed.reverse()) {
      const temporary = join(
        dirname(entry.path),
        `.${basename(entry.path)}.plugin-rollback-${randomUUID()}`,
      );
      try {
        writeFileSync(temporary, entry.current, "utf8");
        renameSync(temporary, entry.path);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${entry.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
        try {
          rmSync(temporary, { force: true });
        } catch {
          // Preserve the original rollback error if cleanup also fails.
        }
      }
    }
    const detail = rollbackErrors.length
      ? `; rollback errors: ${rollbackErrors.join(", ")}`
      : "; committed files were rolled back";
    throw new Error(
      `Plugin promotion write failed: ${error instanceof Error ? error.message : String(error)}${detail}`,
    );
  } finally {
    for (const entry of staged) {
      rmSync(entry.temporary, { force: true });
    }
  }
}

function printUpdates(updates) {
  for (const entry of updates) {
    const relative = entry.path.slice(repositoryRoot.length + 1);
    console.log(
      `  ${relative}: ${entry.current === entry.next ? "unchanged" : "update"}`,
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
  if (!parsed.cliVersion || !parsed.pluginVersion) {
    throw new Error(
      "Usage: node scripts/plugin-promote.mjs --cli-version VERSION --plugin-version VERSION [--write]",
    );
  }
  return parsed;
}
