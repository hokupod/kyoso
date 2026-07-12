import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const pluginId = "kyoso@kyoso";
const pluginMcpServerName = "kyoso";
const canonicalSkillRelativePath = ".agents/skills/kyoso-review";
const pluginSkillRelativePath = "plugins/kyoso/skills/kyoso-review";
const pluginRootRelativePath = "plugins/kyoso";
const pluginSkillInstructionsRelativePath = "SKILL.md";
const pluginOpenAiMetadataRelativePath = "agents/openai.yaml";
const unpinnedCliFallbacks = ["`npx -y @kyo-so/cli`", "`bunx @kyo-so/cli`"];
const pluginMcpDependencyBlock = [
  "dependencies:",
  "  tools:",
  '    - type: "mcp"',
  `      value: "${pluginMcpServerName}"`,
  '      description: "Kyoso MCP server"',
  '      transport: "stdio"',
].join("\n");
const allowedMcpEnvVars = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CODEX_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/,
];
const forbiddenDistributionKeys = new Set([
  "approval",
  "approvals",
  "approval_policy",
  "cwd",
  "dangerously_bypass_approvals_and_sandbox",
  "dangerously_bypass_hook_trust",
  "env",
  "sandbox",
  "sandbox_permissions",
  "trust",
]);
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const allowedClaudeManifestKeys = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "mcpServers",
]);
const allowedClaudeAuthorKeys = new Set(["name", "url"]);
const allowedClaudeMcpServerKeys = new Set(["command", "args", "env"]);

export function distributionPaths(root = repositoryRoot) {
  return {
    root,
    catalog: join(root, ".agents", "plugins", "marketplace.json"),
    claudeManifest: join(
      root,
      pluginRootRelativePath,
      ".claude-plugin",
      "plugin.json",
    ),
    claudeMarketplace: join(root, ".claude-plugin", "marketplace.json"),
    canonicalSkill: join(root, canonicalSkillRelativePath),
    compatibility: join(
      root,
      "docs",
      "compatibility",
      "codex-plugin-runtime.json",
    ),
    manifest: join(
      root,
      pluginRootRelativePath,
      ".codex-plugin",
      "plugin.json",
    ),
    mcp: join(root, pluginRootRelativePath, ".codex-plugin", "mcp.json"),
    pluginRoot: join(root, pluginRootRelativePath),
    pluginSkill: join(root, pluginSkillRelativePath),
    runtimeContract: join(root, "src", "cli", "pluginRuntimeContract.ts"),
  };
}

/**
 * Apply the Plugin-only Skill metadata contract to canonical Skill content.
 * The canonical Skill remains MCP-optional for skill-only installation.
 */
export function transformCanonicalToPlugin(
  relativePath,
  content,
  cliPackagePin,
) {
  let transformed = content;
  if (relativePath === pluginSkillInstructionsRelativePath) {
    if (!parsePackagePin(cliPackagePin)) {
      throw new Error(
        "Plugin Skill transform requires an exact @kyo-so/cli SemVer pin",
      );
    }
    let instructions = content.toString("utf8");
    for (const fallback of unpinnedCliFallbacks) {
      const occurrences = instructions.split(fallback).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Canonical Skill ${relativePath} must contain exactly one ${fallback} fallback`,
        );
      }
      instructions = instructions.replace(
        fallback,
        fallback.replace("@kyo-so/cli", cliPackagePin),
      );
    }
    transformed = Buffer.from(instructions, "utf8");
  }

  if (relativePath !== pluginOpenAiMetadataRelativePath) return transformed;

  const metadata = transformed.toString("utf8");
  if (metadata.endsWith(`${pluginMcpDependencyBlock}\n`)) return transformed;
  if (/^dependencies:\s*$/m.test(metadata)) {
    throw new Error(
      `Canonical Skill ${relativePath} must not declare Plugin dependencies`,
    );
  }
  return Buffer.from(
    `${metadata.trimEnd()}\n\n${pluginMcpDependencyBlock}\n`,
    "utf8",
  );
}

/**
 * Check every tracked Plugin artifact without modifying the worktree.
 * `verifyPackageArchive` runs `npm pack --dry-run --ignore-scripts` so the
 * package allowlist is checked before a real pack or publish.
 */
export function verifyPluginDistribution(options = {}) {
  const root = options.root ?? repositoryRoot;
  const verifyPackageArchive = options.verifyPackageArchive ?? true;
  const expectedPackageVersion = options.expectedPackageVersion;
  const paths = distributionPaths(root);
  const failures = [];
  // Claude Code auto-detects a plugin-root .mcp.json before the inline
  // mcpServers declaration in the Claude plugin manifest.
  if (existsSync(join(paths.pluginRoot, ".mcp.json"))) {
    failures.push("Plugin root must not contain .mcp.json");
  }
  const catalog = readJson(paths.catalog, "Marketplace catalog", failures);
  const manifest = readJson(paths.manifest, "Plugin manifest", failures);
  const mcp = readJson(paths.mcp, "Plugin MCP config", failures);
  const claudeManifest = readJson(
    paths.claudeManifest,
    "Claude plugin manifest",
    failures,
  );
  const claudeMarketplace = readJson(
    paths.claudeMarketplace,
    "Claude marketplace",
    failures,
  );
  const compatibility = readJson(
    paths.compatibility,
    "Plugin compatibility record",
    failures,
  );
  const packageMetadata = readJson(
    join(root, "package.json"),
    "package.json",
    failures,
  );

  const catalogPlugin = validateCatalog(catalog, paths, failures);
  validateManifest(manifest, paths, failures);
  const pin = validateMcp(mcp, failures);
  const claudePin = validateClaudeManifest(claudeManifest, paths, failures);
  const claudeMarketplaceVersions = validateClaudeMarketplace(
    claudeMarketplace,
    failures,
  );
  validateClaudeVersionConsistency(
    manifest,
    claudeManifest,
    claudeMarketplaceVersions,
    compatibility,
    failures,
  );
  validateClaudePinConsistency(pin, claudePin, failures);
  validateDistributionSafety(
    { catalog, manifest, mcp, claudeManifest, claudeMarketplace },
    failures,
  );
  validatePackageAllowlist(packageMetadata, failures);
  validatePackageVersion(
    packageMetadata,
    pin,
    claudePin,
    failures,
    expectedPackageVersion,
  );
  validateSkillMirror(paths, pin, failures);
  validateRuntimeContract(paths, compatibility, manifest, pin, failures);

  if (failures.length === 0 && verifyPackageArchive) {
    try {
      assertPackageArchiveExcludesPluginPaths(root);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Plugin distribution verification failed:\n${failures
        .map((failure) => `- ${failure}`)
        .join("\n")}`,
    );
  }

  return {
    pluginId,
    pluginVersion: manifest.version,
    packageName: pin.packageName,
    packageVersion: pin.packageVersion,
    sourcePath: catalogPlugin.source.path,
  };
}

/** Generate the Plugin Skill mirror from the canonical Skill directory. */
export function syncPluginSkill(root = repositoryRoot, options = {}) {
  const paths = distributionPaths(root);
  const { canonicalSkill, pluginSkill } = paths;
  const cliPackagePin = readPluginPackagePin(paths.mcp);
  const sourceFiles = listSkillFiles(canonicalSkill, { includeMarker: true });
  if (sourceFiles.length === 0) {
    throw new Error("Canonical kyoso-review Skill is empty");
  }

  const parent = dirname(pluginSkill);
  mkdirSync(parent, { recursive: true });
  if (existsSync(pluginSkill) && lstatSync(pluginSkill).isSymbolicLink()) {
    throw new Error(
      `Plugin Skill mirror must not be a symlink: ${pluginSkill}`,
    );
  }

  const stageRoot = mkdtempSync(join(parent, ".kyoso-review-sync-"));
  const stage = join(stageRoot, "kyoso-review");
  const backup = join(
    parent,
    `.kyoso-review-backup-${process.pid}-${Date.now()}`,
  );
  let movedExisting = false;
  let installed = false;
  let synchronized = false;

  try {
    cpSync(canonicalSkill, stage, {
      dereference: false,
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    applyCanonicalPluginTransforms(canonicalSkill, stage, cliPackagePin);
    assertSkillDirectoriesEqual(canonicalSkill, stage, cliPackagePin);

    if (existsSync(pluginSkill)) {
      renameSync(pluginSkill, backup);
      movedExisting = true;
    }
    renameSync(stage, pluginSkill);
    installed = true;
    options.afterInstall?.({ canonicalSkill, pluginSkill });
    assertSkillDirectoriesEqual(canonicalSkill, pluginSkill, cliPackagePin);
    synchronized = true;
  } catch (error) {
    if (movedExisting || installed) {
      try {
        if (existsSync(pluginSkill)) {
          rmSync(pluginSkill, { force: true, recursive: true });
        }
        if (movedExisting) {
          if (!existsSync(backup)) {
            throw new Error("Plugin Skill backup disappeared before rollback");
          }
          renameSync(backup, pluginSkill);
        }
      } catch (rollbackError) {
        throw new Error(
          `Plugin Skill mirror sync failed: ${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    rmSync(stageRoot, { force: true, recursive: true });
    if (synchronized && existsSync(backup)) {
      rmSync(backup, { force: true, recursive: true });
    }
  }

  const canonicalDigest = hashSkillDirectory(canonicalSkill);
  const pluginDigest = hashSkillDirectory(pluginSkill);
  return {
    destination: pluginSkill,
    digest: canonicalDigest,
    canonicalDigest,
    pluginDigest,
  };
}

/**
 * Assert that the Plugin Skill matches canonical content after Plugin-only
 * transforms, including files excluded from install hashes.
 */
export function assertPluginSkillMirror(root = repositoryRoot) {
  const paths = distributionPaths(root);
  const { canonicalSkill, pluginSkill } = paths;
  const cliPackagePin = readPluginPackagePin(paths.mcp);
  assertSkillDirectoriesEqual(canonicalSkill, pluginSkill, cliPackagePin);
  return {
    canonicalDigest: hashSkillDirectory(canonicalSkill),
    pluginDigest: hashSkillDirectory(pluginSkill),
  };
}

export function readBundledPluginRuntimeContract(root = repositoryRoot) {
  const path = distributionPaths(root).runtimeContract;
  const source = readFileSync(path, "utf8");
  const schemaVersion = parseNumberExport(
    source,
    "PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION",
    path,
  );
  const minimumSupportedCodexVersion = parseStringExport(
    source,
    "MINIMUM_SUPPORTED_CODEX_VERSION",
    path,
  );
  const expectedContract = parseJsonObjectExport(
    source,
    "PLUGIN_RUNTIME_EXPECTED_CONTRACT",
    path,
  );
  return {
    schemaVersion,
    minimumSupportedCodexVersion,
    expectedContract,
  };
}

function validateCatalog(catalog, paths, failures) {
  if (!isObject(catalog)) {
    failures.push("Marketplace catalog must be a JSON object");
    return undefined;
  }
  if (catalog.name !== "kyoso") {
    failures.push('Marketplace catalog name must be "kyoso"');
  }
  if (catalog.interface?.displayName !== "Kyoso") {
    failures.push('Marketplace catalog interface.displayName must be "Kyoso"');
  }
  if (!Array.isArray(catalog.plugins)) {
    failures.push("Marketplace catalog plugins must be an array");
    return undefined;
  }
  const matches = catalog.plugins.filter((plugin) => plugin?.name === "kyoso");
  if (matches.length !== 1) {
    failures.push("Marketplace catalog must contain exactly one kyoso Plugin");
    return undefined;
  }
  const plugin = matches[0];
  if (plugin.source?.source !== "local") {
    failures.push('Marketplace Plugin source.source must be "local"');
  }
  const sourcePath = validateRelativePath(
    paths.root,
    plugin.source?.path,
    "Marketplace Plugin source.path",
    failures,
  );
  if (sourcePath && sourcePath !== paths.pluginRoot) {
    failures.push(
      "Marketplace Plugin source.path must resolve to plugins/kyoso",
    );
  }
  if (plugin.policy?.installation !== "AVAILABLE") {
    failures.push('Marketplace Plugin policy.installation must be "AVAILABLE"');
  }
  if (plugin.policy?.authentication !== "ON_USE") {
    failures.push('Marketplace Plugin policy.authentication must be "ON_USE"');
  }
  if (plugin.category !== "Engineering") {
    failures.push('Marketplace Plugin category must be "Engineering"');
  }
  return plugin;
}

function validateManifest(manifest, paths, failures) {
  if (!isObject(manifest)) {
    failures.push("Plugin manifest must be a JSON object");
    return;
  }
  for (const key of ["description", "homepage", "license", "repository"]) {
    if (!isNonEmptyString(manifest[key])) {
      failures.push(`Plugin manifest ${key} must be a non-empty string`);
    }
  }
  if (manifest.name !== "kyoso") {
    failures.push('Plugin manifest name must be "kyoso"');
  }
  if (
    !isNonEmptyString(manifest.version) ||
    !semverPattern.test(manifest.version)
  ) {
    failures.push("Plugin manifest version must be a complete SemVer version");
  }
  if (
    !isObject(manifest.author) ||
    !isNonEmptyString(manifest.author.name) ||
    !isHttpsUrl(manifest.author.url)
  ) {
    failures.push("Plugin manifest author must include a name and HTTPS URL");
  }
  if (!isHttpsUrl(manifest.homepage) || !isHttpsUrl(manifest.repository)) {
    failures.push("Plugin manifest homepage and repository must be HTTPS URLs");
  }
  if (
    !Array.isArray(manifest.keywords) ||
    manifest.keywords.length === 0 ||
    !manifest.keywords.every(isNonEmptyString)
  ) {
    failures.push("Plugin manifest keywords must be a non-empty string array");
  }
  const skillsPath = validateRelativePath(
    paths.pluginRoot,
    manifest.skills,
    "Plugin manifest skills",
    failures,
  );
  if (skillsPath && skillsPath !== join(paths.pluginRoot, "skills")) {
    failures.push("Plugin manifest skills must resolve to ./skills/");
  }
  const mcpPath = validateRelativePath(
    paths.pluginRoot,
    manifest.mcpServers,
    "Plugin manifest mcpServers",
    failures,
  );
  if (mcpPath && mcpPath !== paths.mcp) {
    failures.push(
      "Plugin manifest mcpServers must resolve to ./.codex-plugin/mcp.json",
    );
  }
  const interfaceMetadata = manifest.interface;
  if (!isObject(interfaceMetadata)) {
    failures.push("Plugin manifest interface must be an object");
    return;
  }
  for (const key of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
  ]) {
    if (!isNonEmptyString(interfaceMetadata[key])) {
      failures.push(
        `Plugin manifest interface.${key} must be a non-empty string`,
      );
    }
  }
  if (interfaceMetadata.category !== "Engineering") {
    failures.push('Plugin manifest interface.category must be "Engineering"');
  }
  if (
    !Array.isArray(interfaceMetadata.capabilities) ||
    interfaceMetadata.capabilities.length !== 1 ||
    interfaceMetadata.capabilities[0] !== "Read"
  ) {
    failures.push('Plugin manifest capabilities must be exactly ["Read"]');
  }
  if (!isHttpsUrl(interfaceMetadata.websiteUrl)) {
    failures.push("Plugin manifest interface.websiteUrl must be an HTTPS URL");
  }
}

function validateClaudeManifest(manifest, paths, failures) {
  if (!isObject(manifest)) {
    failures.push("Claude plugin manifest must be a JSON object");
    return { packageName: "", packageVersion: "" };
  }
  validateAllowedKeys(
    manifest,
    allowedClaudeManifestKeys,
    "Claude plugin manifest",
    failures,
  );
  for (const key of ["description", "homepage", "license", "repository"]) {
    if (!isNonEmptyString(manifest[key])) {
      failures.push(`Claude plugin manifest ${key} must be a non-empty string`);
    }
  }
  if (manifest.name !== "kyoso") {
    failures.push('Claude plugin manifest name must be "kyoso"');
  }
  if (
    !isNonEmptyString(manifest.version) ||
    !semverPattern.test(manifest.version)
  ) {
    failures.push(
      "Claude plugin manifest version must be a complete SemVer version",
    );
  }
  if (isObject(manifest.author)) {
    validateAllowedKeys(
      manifest.author,
      allowedClaudeAuthorKeys,
      "Claude plugin manifest author",
      failures,
    );
  }
  if (
    !isObject(manifest.author) ||
    !isNonEmptyString(manifest.author.name) ||
    !isHttpsUrl(manifest.author.url)
  ) {
    failures.push(
      "Claude plugin manifest author must include a name and HTTPS URL",
    );
  }
  if (!isHttpsUrl(manifest.homepage) || !isHttpsUrl(manifest.repository)) {
    failures.push(
      "Claude plugin manifest homepage and repository must be HTTPS URLs",
    );
  }
  if (
    !Array.isArray(manifest.keywords) ||
    manifest.keywords.length === 0 ||
    !manifest.keywords.every(isNonEmptyString)
  ) {
    failures.push(
      "Claude plugin manifest keywords must be a non-empty string array",
    );
  }
  const skillsPath = validateRelativePath(
    paths.pluginRoot,
    manifest.skills,
    "Claude plugin manifest skills",
    failures,
  );
  if (skillsPath && skillsPath !== join(paths.pluginRoot, "skills")) {
    failures.push("Claude plugin manifest skills must resolve to ./skills/");
  }
  if (!isObject(manifest.mcpServers)) {
    failures.push("Claude plugin manifest mcpServers must be an inline object");
    return { packageName: "", packageVersion: "" };
  }
  if (
    Object.keys(manifest.mcpServers).length !== 1 ||
    !isObject(manifest.mcpServers[pluginMcpServerName])
  ) {
    failures.push(
      `Claude plugin manifest mcpServers must be a direct map with only ${pluginMcpServerName}`,
    );
    return { packageName: "", packageVersion: "" };
  }
  const server = manifest.mcpServers[pluginMcpServerName];
  validateAllowedKeys(
    server,
    allowedClaudeMcpServerKeys,
    `Claude plugin manifest mcpServers.${pluginMcpServerName}`,
    failures,
  );
  if (server.env !== undefined) {
    validateClaudeMcpEnv(server.env, failures);
  }
  if (server.command !== "npx") {
    failures.push('Claude plugin MCP command must be "npx"');
  }
  if (
    !Array.isArray(server.args) ||
    server.args.length !== 3 ||
    server.args[0] !== "-y" ||
    server.args[2] !== "mcp"
  ) {
    failures.push(
      'Claude plugin MCP args must be ["-y", "@kyo-so/cli@VERSION", "mcp"]',
    );
  }
  const pin = parsePackagePin(server.args?.[1]);
  if (!pin) {
    failures.push(
      "Claude plugin MCP package pin must be an exact @kyo-so/cli SemVer",
    );
  }
  return pin ?? { packageName: "", packageVersion: "" };
}

function validateClaudeMarketplace(marketplace, failures) {
  if (!isObject(marketplace)) {
    failures.push("Claude marketplace must be a JSON object");
    return { metadataVersion: undefined, pluginVersion: undefined };
  }
  const metadataVersion = marketplace.metadata?.version;
  if (!isObject(marketplace.metadata)) {
    failures.push("Claude marketplace metadata must be an object");
  } else if (
    !isNonEmptyString(metadataVersion) ||
    !semverPattern.test(metadataVersion)
  ) {
    failures.push(
      "Claude marketplace metadata.version must be a complete SemVer version",
    );
  }
  if (!Array.isArray(marketplace.plugins)) {
    failures.push("Claude marketplace plugins must be an array");
    return { metadataVersion, pluginVersion: undefined };
  }
  const plugin = marketplace.plugins[0];
  if (!isObject(plugin)) {
    failures.push("Claude marketplace plugins[0] must be an object");
    return { metadataVersion, pluginVersion: undefined };
  }
  const pluginVersion = plugin.version;
  if (!isNonEmptyString(pluginVersion) || !semverPattern.test(pluginVersion)) {
    failures.push(
      "Claude marketplace plugins[0].version must be a complete SemVer version",
    );
  }
  return { metadataVersion, pluginVersion };
}

function validateClaudeMcpEnv(env, failures) {
  if (!isStringRecord(env)) {
    failures.push(
      "Claude plugin MCP env must be an object with non-empty string values",
    );
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (!allowedMcpEnvVars.includes(key)) {
      failures.push(`Claude plugin MCP env has unsupported variable: ${key}`);
    }
    const expectedValue = "$" + "{" + key + "}";
    if (value !== expectedValue) {
      failures.push(
        `Claude plugin MCP env ${key} must forward ${formatValue(expectedValue)}`,
      );
    }
  }
}

function validateClaudeVersionConsistency(
  manifest,
  claudeManifest,
  claudeMarketplaceVersions,
  compatibility,
  failures,
) {
  const claudeVersion = claudeManifest?.version;
  const codexVersion = manifest?.version;
  const contractVersion =
    compatibility?.expectedContract?.distribution?.pluginVersion;
  validateVersionMatch(
    "plugins/kyoso/.claude-plugin/plugin.json version",
    claudeVersion,
    "plugins/kyoso/.codex-plugin/plugin.json version",
    codexVersion,
    failures,
  );
  validateVersionMatch(
    ".claude-plugin/marketplace.json plugins[0].version",
    claudeMarketplaceVersions.pluginVersion,
    "plugins/kyoso/.claude-plugin/plugin.json version",
    claudeVersion,
    failures,
  );
  validateVersionMatch(
    ".claude-plugin/marketplace.json metadata.version",
    claudeMarketplaceVersions.metadataVersion,
    "plugins/kyoso/.claude-plugin/plugin.json version",
    claudeVersion,
    failures,
  );
  validateVersionMatch(
    "plugins/kyoso/.claude-plugin/plugin.json version",
    claudeVersion,
    "docs/compatibility/codex-plugin-runtime.json expectedContract.distribution.pluginVersion",
    contractVersion,
    failures,
  );
}

function validateClaudePinConsistency(pin, claudePin, failures) {
  const codexPackagePin = packagePin(pin);
  const claudePackagePin = packagePin(claudePin);
  if (claudePackagePin !== codexPackagePin) {
    failures.push(
      `plugins/kyoso/.claude-plugin/plugin.json mcpServers.kyoso.args[1] ${formatValue(claudePackagePin)} must match plugins/kyoso/.codex-plugin/mcp.json kyoso.args[1] ${formatValue(codexPackagePin)}`,
    );
  }
}

function validateVersionMatch(
  actualLabel,
  actual,
  expectedLabel,
  expected,
  failures,
) {
  if (actual !== expected) {
    failures.push(
      `${actualLabel} ${formatValue(actual)} must match ${expectedLabel} ${formatValue(expected)}`,
    );
  }
}

function validateMcp(mcp, failures) {
  if (!isObject(mcp)) {
    failures.push("Plugin MCP config must be a JSON object");
    return { packageName: "", packageVersion: "" };
  }
  // The transform uses this same name for the Plugin Skill dependency, and
  // the transform-aware mirror check verifies the generated metadata bytes.
  if (Object.keys(mcp).length !== 1 || !isObject(mcp[pluginMcpServerName])) {
    failures.push(
      `Plugin MCP config must be a direct map with only ${pluginMcpServerName}`,
    );
    return { packageName: "", packageVersion: "" };
  }
  const server = mcp[pluginMcpServerName];
  const allowedKeys = new Set([
    "command",
    "args",
    "env_vars",
    "startup_timeout_sec",
    "tool_timeout_sec",
  ]);
  for (const key of Object.keys(server)) {
    if (!allowedKeys.has(key)) {
      failures.push(`Plugin MCP config has unsupported key: kyoso.${key}`);
    }
  }
  if (server.command !== "npx") {
    failures.push('Plugin MCP command must be "npx"');
  }
  if (
    !Array.isArray(server.args) ||
    server.args.length !== 3 ||
    server.args[0] !== "-y" ||
    server.args[2] !== "mcp"
  ) {
    failures.push(
      'Plugin MCP args must be ["-y", "@kyo-so/cli@VERSION", "mcp"]',
    );
  }
  const pin = parsePackagePin(server.args?.[1]);
  if (!pin) {
    failures.push("Plugin MCP package pin must be an exact @kyo-so/cli SemVer");
  }
  if (!isExactArray(server.env_vars, allowedMcpEnvVars)) {
    failures.push(
      "Plugin MCP env_vars must match the six-item allowlist exactly",
    );
  }
  if (server.startup_timeout_sec !== 20 || server.tool_timeout_sec !== 360) {
    failures.push("Plugin MCP timeouts must remain 20 and 360 seconds");
  }
  return pin ?? { packageName: "", packageVersion: "" };
}

function validateDistributionSafety(distribution, failures) {
  const serialized = JSON.stringify(distribution);
  for (const pattern of secretPatterns) {
    if (pattern.test(serialized)) {
      failures.push("Plugin distribution contains a possible secret literal");
      break;
    }
  }
  if (/<[A-Z][A-Z0-9_]*>|@kyo-so\/cli@0\.7\.1\b/.test(serialized)) {
    failures.push(
      "Plugin distribution contains an unpublished or placeholder CLI pin",
    );
  }
  collectForbiddenKeys(distribution, "", failures);
}

function validatePackageAllowlist(packageMetadata, failures) {
  if (!isObject(packageMetadata) || !Array.isArray(packageMetadata.files)) {
    failures.push(
      "package.json files allowlist is required for Plugin tarball exclusion",
    );
    return;
  }
  const forbidden = ["plugins", ".agents/plugins", ".claude-plugin"];
  for (const prefix of forbidden) {
    if (
      packageMetadata.files.some(
        (entry) =>
          typeof entry === "string" &&
          (entry === prefix || entry.startsWith(`${prefix}/`)),
      )
    ) {
      failures.push(`package.json files allowlist must exclude ${prefix}/`);
    }
  }
}

function validatePackageVersion(
  packageMetadata,
  pin,
  claudePin,
  failures,
  expectedPackageVersion,
) {
  if (
    !isObject(packageMetadata) ||
    !isNonEmptyString(packageMetadata.version) ||
    !semverPattern.test(packageMetadata.version)
  ) {
    failures.push("package.json version must be a complete SemVer version");
    return;
  }
  if (
    expectedPackageVersion !== undefined &&
    packageMetadata.version !== expectedPackageVersion
  ) {
    failures.push(
      `package.json version ${packageMetadata.version} must match expected package version ${expectedPackageVersion}`,
    );
  }
  if (
    expectedPackageVersion !== undefined &&
    pin.packageVersion !== expectedPackageVersion
  ) {
    failures.push(
      `Plugin MCP pin ${packagePin(pin)} must match expected package version ${expectedPackageVersion}`,
    );
  }
  if (
    expectedPackageVersion !== undefined &&
    claudePin.packageVersion !== expectedPackageVersion
  ) {
    failures.push(
      `Claude plugin MCP pin ${packagePin(claudePin)} must match expected package version ${expectedPackageVersion}`,
    );
  }
}

function validateSkillMirror(paths, pin, failures) {
  try {
    const cliPackagePin = packagePin(pin);
    if (!cliPackagePin) {
      throw new Error("Plugin Skill mirror requires a valid Plugin MCP pin");
    }
    const sourceDigest = hashSkillDirectory(paths.canonicalSkill);
    const mirrorDigest = hashSkillDirectory(paths.pluginSkill);
    const expectedPluginDigest = hashTransformedPluginSkillDirectory(
      paths.canonicalSkill,
      cliPackagePin,
    );
    const currentDigest = readCurrentSkillDigest(paths.root);
    if (sourceDigest !== currentDigest) {
      failures.push(
        `Canonical Skill digest ${sourceDigest} does not match CURRENT_SKILL_DIGEST ${currentDigest}`,
      );
    }
    if (mirrorDigest !== expectedPluginDigest) {
      failures.push(
        `Plugin Skill digest ${mirrorDigest} does not match transformed canonical Skill digest ${expectedPluginDigest}`,
      );
    }
    assertSkillDirectoriesEqual(
      paths.canonicalSkill,
      paths.pluginSkill,
      cliPackagePin,
    );
  } catch (error) {
    failures.push(errorMessage(error));
  }
}

function validateRuntimeContract(
  paths,
  compatibility,
  manifest,
  pin,
  failures,
) {
  if (!isObject(compatibility)) {
    failures.push("Plugin compatibility record must be a JSON object");
    return;
  }
  try {
    const bundled = readBundledPluginRuntimeContract(paths.root);
    const documented = {
      schemaVersion: compatibility.schemaVersion,
      minimumSupportedCodexVersion: compatibility.minimumSupportedCodexVersion,
      expectedContract: compatibility.expectedContract,
    };
    if (!isDeepStrictEqual(bundled, documented)) {
      failures.push(
        "Bundled Plugin runtime contract must structurally match docs/compatibility/codex-plugin-runtime.json",
      );
    }
  } catch (error) {
    failures.push(errorMessage(error));
  }
  if (
    !Array.isArray(compatibility.probes) ||
    compatibility.probes.length === 0
  ) {
    failures.push(
      "Plugin compatibility record must contain at least one probe",
    );
  } else if (
    !compatibility.probes.some(
      (probe) =>
        probe?.codexVersion === compatibility.minimumSupportedCodexVersion,
    )
  ) {
    failures.push(
      "Plugin compatibility record minimumSupportedCodexVersion must have a matching probe",
    );
  }
  const contract = compatibility.expectedContract;
  if (contract?.distribution?.pluginVersion !== manifest?.version) {
    failures.push(
      "Plugin manifest version must match the compatibility contract",
    );
  }
  if (contract?.distribution?.mcpPackagePin !== packagePin(pin)) {
    failures.push(
      "Plugin MCP package pin must match the compatibility contract",
    );
  }
  if (contract?.marketplace?.pluginId !== pluginId) {
    failures.push(
      `Plugin compatibility contract marketplace.pluginId must be ${pluginId}`,
    );
  }
}

// npm's stdout cannot be parsed reliably here: credential/scanner shims such
// as safe-chain interpose the npm command in CI and interleave their own
// output with the --json payload. Pack a real archive instead and list its
// entries with tar, which the shims do not touch.
function assertPackageArchiveExcludesPluginPaths(root) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "kyoso-plugin-pack-"));
  try {
    const archiveDir = join(cacheRoot, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const result = spawnSync(
      "npm",
      [
        "--cache",
        join(cacheRoot, "npm-cache"),
        "pack",
        "--ignore-scripts",
        "--pack-destination",
        archiveDir,
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (result.error) {
      throw new Error(`npm pack failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `npm pack failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const archives = readdirSync(archiveDir).filter((name) =>
      name.endsWith(".tgz"),
    );
    if (archives.length !== 1) {
      throw new Error(
        `npm pack produced ${archives.length} archives; expected exactly 1`,
      );
    }
    const listing = spawnSync("tar", ["-tzf", join(archiveDir, archives[0])], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    if (listing.error || listing.status !== 0) {
      throw new Error(
        `tar listing failed: ${listing.error?.message ?? listing.stderr.trim()}`,
      );
    }
    const paths = listing.stdout
      .split("\n")
      .map((entry) => entry.trim().replace(/^package\//, ""))
      .filter((entry) => entry.length > 0);
    if (paths.length === 0) {
      throw new Error("tar listing returned no package entries");
    }
    for (const prefix of ["plugins/", ".agents/plugins/", ".claude-plugin/"]) {
      if (paths.some((path) => path.startsWith(prefix))) {
        throw new Error(
          `npm pack archive includes forbidden Plugin path: ${prefix}`,
        );
      }
    }
  } finally {
    rmSync(cacheRoot, { force: true, recursive: true });
  }
}

function validateRelativePath(root, value, label, failures) {
  if (!isNonEmptyString(value) || !value.startsWith("./")) {
    failures.push(`${label} must be a ./-prefixed relative path`);
    return undefined;
  }
  if (value.split(/[\\/]/).includes("..")) {
    failures.push(`${label} must not contain parent traversal`);
    return undefined;
  }
  const resolved = resolve(root, value);
  const pathFromRoot = relative(root, resolved);
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    failures.push(`${label} must stay within its root`);
    return undefined;
  }
  if (!existsSync(resolved)) {
    failures.push(`${label} target does not exist: ${value}`);
    return undefined;
  }
  return resolved;
}

function hashSkillDirectory(directory) {
  return hashSkillFiles(listSkillFiles(directory, { includeMarker: false }));
}

function hashTransformedPluginSkillDirectory(directory, cliPackagePin) {
  return hashSkillFiles(
    listSkillFiles(directory, { includeMarker: false }).map((file) => ({
      ...file,
      contents: transformCanonicalToPlugin(
        file.relativePath,
        file.contents,
        cliPackagePin,
      ),
    })),
  );
}

function hashSkillFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(file.contents.byteLength));
    hash.update("\0");
    hash.update(file.contents);
  }
  return `sha256:${hash.digest("hex")}`;
}

function assertSkillDirectoriesEqual(source, mirror, cliPackagePin) {
  const sourceFiles = listSkillFiles(source, { includeMarker: true });
  const mirrorFiles = listSkillFiles(mirror, { includeMarker: true });
  if (sourceFiles.length !== mirrorFiles.length) {
    throw new Error(
      `Plugin Skill mirror file count differs from canonical Skill (${mirrorFiles.length} != ${sourceFiles.length})`,
    );
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const canonical = sourceFiles[index];
    const plugin = mirrorFiles[index];
    const expectedContents = transformCanonicalToPlugin(
      canonical.relativePath,
      canonical.contents,
      cliPackagePin,
    );
    if (
      canonical.relativePath !== plugin.relativePath ||
      !expectedContents.equals(plugin.contents)
    ) {
      throw new Error(
        `Plugin Skill mirror differs from transformed canonical Skill at ${canonical.relativePath}`,
      );
    }
  }
}

function applyCanonicalPluginTransforms(source, destination, cliPackagePin) {
  for (const file of listSkillFiles(source, { includeMarker: true })) {
    const transformed = transformCanonicalToPlugin(
      file.relativePath,
      file.contents,
      cliPackagePin,
    );
    if (!transformed.equals(file.contents)) {
      writeFileSync(join(destination, file.relativePath), transformed);
    }
  }
}

function listSkillFiles(directory, options, prefix = "") {
  const root = lstatSync(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new Error(`Skill root must be a regular directory: ${directory}`);
  }
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill directory contains a symlink: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      result.push(...listSkillFiles(path, options, relativePath));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Skill directory contains a non-regular file: ${relativePath}`,
      );
    }
    if (!options.includeMarker && relativePath === ".kyoso-install.json") {
      continue;
    }
    result.push({ relativePath, contents: readFileSync(path) });
  }
  result.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath),
      Buffer.from(right.relativePath),
    ),
  );
  return result;
}

function readCurrentSkillDigest(root) {
  const source = readFileSync(
    join(root, "src", "cli", "knownSkillDigests.ts"),
    "utf8",
  );
  const match = source.match(
    /CURRENT_SKILL_DIGEST\s*=\s*["'](sha256:[a-f0-9]{64})["']/,
  );
  if (!match?.[1]) {
    throw new Error(
      "Could not read CURRENT_SKILL_DIGEST from knownSkillDigests.ts",
    );
  }
  return match[1];
}

function parsePackagePin(value) {
  if (!isNonEmptyString(value)) return undefined;
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const packageName = value.slice(0, separator);
  const packageVersion = value.slice(separator + 1);
  if (packageName !== "@kyo-so/cli" || !semverPattern.test(packageVersion)) {
    return undefined;
  }
  return { packageName, packageVersion };
}

function readPluginPackagePin(path) {
  let mcp;
  try {
    mcp = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Plugin MCP config could not be read: ${errorMessage(error)}`,
    );
  }
  const pin = parsePackagePin(mcp?.[pluginMcpServerName]?.args?.[1]);
  if (!pin) {
    throw new Error(
      "Plugin MCP package pin must be an exact @kyo-so/cli SemVer",
    );
  }
  return packagePin(pin);
}

function packagePin(pin) {
  return pin.packageName ? `${pin.packageName}@${pin.packageVersion}` : "";
}

function formatValue(value) {
  return JSON.stringify(value) ?? String(value);
}

function validateAllowedKeys(value, allowedKeys, label, failures) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      failures.push(`${label} has unsupported key: ${key}`);
    }
  }
}

function collectForbiddenKeys(value, prefix, failures) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectForbiddenKeys(item, `${prefix}[${index}]`, failures),
    );
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      isForbiddenDistributionKey(normalizeDistributionKey(key)) &&
      !isAllowedClaudeMcpEnvPath(path)
    ) {
      failures.push(`Plugin distribution must not contain ${path}`);
    }
    collectForbiddenKeys(child, path, failures);
  }
}

function normalizeDistributionKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function isForbiddenDistributionKey(key) {
  return (
    forbiddenDistributionKeys.has(key) ||
    key.startsWith("approval_") ||
    key.startsWith("sandbox_") ||
    key.startsWith("trust_")
  );
}

function isAllowedClaudeMcpEnvPath(path) {
  return path === `claudeManifest.mcpServers.${pluginMcpServerName}.env`;
}

function readJson(path, label, failures) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${label} could not be read: ${errorMessage(error)}`);
    return undefined;
  }
}

function parseNumberExport(source, name, path) {
  const match = source.match(new RegExp(`export const ${name} = (\\d+);`));
  if (!match?.[1]) throw new Error(`Could not read ${name} from ${path}`);
  return Number(match[1]);
}

function parseStringExport(source, name, path) {
  const match = source.match(
    new RegExp(`export const ${name} = ["']([^"']+)["'];`),
  );
  if (!match?.[1]) throw new Error(`Could not read ${name} from ${path}`);
  return match[1];
}

function parseJsonObjectExport(source, name, path) {
  const marker = `export const ${name} =`;
  const markerIndex = source.indexOf(marker);
  const start = source.indexOf("{", markerIndex);
  if (markerIndex === -1 || start === -1) {
    throw new Error(`Could not read ${name} from ${path}`);
  }
  const objectLiteral = extractJsonObject(source, start);
  // Prettier formats TypeScript object literals with unquoted property names
  // and trailing commas. Normalize that constrained subset before JSON parsing.
  const json = objectLiteral
    .replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Could not parse ${name} from ${path}: ${errorMessage(error)}`,
    );
  }
}

function extractJsonObject(source, start) {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error("Unterminated JSON object");
}

function isExactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value) {
  return isObject(value) && Object.values(value).every(isNonEmptyString);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isHttpsUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
