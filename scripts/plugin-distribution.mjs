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
const promotionWorkflowRelativePath = ".github/workflows/plugin-promotion.yml";
const promotionWorkflowPullRequestPaths = [
  ".agents/plugins/**",
  ".agents/skills/kyoso-review/**",
  ".claude-plugin/**",
  "plugins/**",
  "docs/compatibility/codex-plugin-runtime.json",
  "src/cli/knownSkillDigests.ts",
  "src/cli/pluginRuntimeContract.ts",
  "scripts/plugin-*.mjs",
  "scripts/mcp-smoke.mjs",
  "scripts/verify-plugin*.mjs",
  "scripts/verify-published-cli.mjs",
];
const promotionWorkflowPushBranches = ["main"];
const promotionWorkflowPushPaths = [
  ".claude-plugin/marketplace.json",
  "docs/compatibility/codex-plugin-runtime.json",
  "plugins/kyoso/.claude-plugin/plugin.json",
  "plugins/kyoso/.codex-plugin/mcp.json",
  "plugins/kyoso/.codex-plugin/plugin.json",
  "plugins/kyoso/skills/kyoso-review/SKILL.md",
  "src/cli/pluginRuntimeContract.ts",
];
const promotionCloseJobCondition =
  ">- ${{ (github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}";
const skillFallbackRunners = ["npx", "bunx"];
const promotionJobExecutionModifierKeys = ["if", "continue-on-error"];
const promotionStepExecutionModifierKeys = [
  ...promotionJobExecutionModifierKeys,
  "shell",
];
const pluginMcpPackageArgumentPrefix = "--package=";
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
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
];
const claudeMcpEnv = {
  ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}",
  CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN:-}",
  OPENROUTER_API_KEY: "${OPENROUTER_API_KEY:-}",
};
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
    promotionWorkflow: join(root, promotionWorkflowRelativePath),
    runtimeContract: join(root, "src", "cli", "pluginRuntimeContract.ts"),
  };
}

export function buildPluginMcpArgs(cliPackagePin) {
  if (!parsePackagePin(cliPackagePin)) {
    throw new Error("Plugin MCP args require an exact @kyo-so/cli SemVer pin");
  }
  return [
    "-y",
    `${pluginMcpPackageArgumentPrefix}${cliPackagePin}`,
    pluginMcpServerName,
    "mcp",
  ];
}

function buildSkillCliFallback(runner, packageSpecifier) {
  if (runner === "npx") {
    return `\`npx -y --package=${packageSpecifier} kyoso\``;
  }
  return `\`bunx --package ${packageSpecifier} kyoso\``;
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
    for (const runner of skillFallbackRunners) {
      const canonicalFallback = buildSkillCliFallback(runner, "@kyo-so/cli");
      const pinnedFallback = buildSkillCliFallback(runner, cliPackagePin);
      const occurrences = instructions.split(canonicalFallback).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Canonical Skill ${relativePath} must contain exactly one ${canonicalFallback} fallback`,
        );
      }
      instructions = instructions.replace(canonicalFallback, pinnedFallback);
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
  const verifyPromotionWorkflow =
    options.verifyPromotionWorkflow ?? root === repositoryRoot;
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
  validatePackageExecutable(packageMetadata, failures);
  validateRuntimeScripts(packageMetadata, failures);
  if (verifyPromotionWorkflow) validatePromotionWorkflow(paths, failures);
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
  validateClaudeMcpEnv(server.env, failures);
  const pin = validatePluginMcpInvocation(
    server,
    "Claude plugin MCP",
    failures,
  );
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
  if (!isExactStringRecord(env, claudeMcpEnv)) {
    failures.push(
      "Claude plugin MCP env must match the optional credential placeholders exactly",
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (!allowedMcpEnvVars.includes(key)) {
      failures.push(`Claude plugin MCP env has unsupported variable: ${key}`);
    }
    const expectedValue = "$" + "{" + key + ":-}";
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
      `Claude plugin MCP package pin ${formatValue(claudePackagePin)} must match Codex plugin MCP package pin ${formatValue(codexPackagePin)}`,
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
  const pin = validatePluginMcpInvocation(server, "Plugin MCP", failures);
  if (!isExactArray(server.env_vars, allowedMcpEnvVars)) {
    failures.push(
      "Plugin MCP env_vars must match the seven-item allowlist exactly",
    );
  }
  if (server.startup_timeout_sec !== 20 || server.tool_timeout_sec !== 2160) {
    failures.push("Plugin MCP timeouts must remain 20 and 2160 seconds");
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

function validatePackageExecutable(packageMetadata, failures) {
  if (
    !isObject(packageMetadata) ||
    !isObject(packageMetadata.bin) ||
    packageMetadata.bin.kyoso !== "dist/bin/kyoso.js"
  ) {
    failures.push('package.json bin.kyoso must equal "dist/bin/kyoso.js"');
  }
}

function validateRuntimeScripts(packageMetadata, failures) {
  const expectedScripts = {
    "plugin:runtime:migrate":
      "node scripts/plugin-runtime-contract-migrate.mjs",
    "plugin:verify:registry": "node scripts/verify-plugin-registry.mjs",
    "plugin:verify:published-cli": "node scripts/verify-published-cli.mjs",
    "plugin:runtime:verify": "node scripts/verify-plugin-runtime.mjs",
    "plugin:promotion:reconcile": "node scripts/plugin-promotion-issues.mjs",
  };
  if (!isObject(packageMetadata) || !isObject(packageMetadata.scripts)) {
    failures.push("package.json scripts must define Plugin runtime commands");
    return;
  }
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (packageMetadata.scripts[name] !== command) {
      failures.push(
        `package.json script ${name} must exactly equal ${formatValue(command)}`,
      );
    }
  }
}

function validatePromotionWorkflow(paths, failures) {
  let workflow;
  try {
    workflow = readFileSync(paths.promotionWorkflow, "utf8");
  } catch (error) {
    failures.push(
      `Plugin promotion workflow could not be read: ${errorMessage(error)}`,
    );
    return;
  }

  const pullRequestPaths = readPromotionWorkflowPaths(workflow);
  if (!pullRequestPaths || !hasExactPromotionWorkflowPaths(pullRequestPaths)) {
    failures.push(
      "Plugin promotion workflow pull_request.paths must contain canonical paths exactly once",
    );
  }

  const pushEvent = readPromotionWorkflowEvent(workflow, "push");
  const pushBranches = readPromotionWorkflowEventList(pushEvent, "branches");
  if (
    !pushBranches ||
    !hasExactWorkflowList(pushBranches, promotionWorkflowPushBranches)
  ) {
    failures.push(
      "Plugin promotion workflow push.branches must contain main exactly once",
    );
  }
  const pushPaths = readPromotionWorkflowEventList(pushEvent, "paths");
  if (
    !pushPaths ||
    !hasExactWorkflowList(pushPaths, promotionWorkflowPushPaths)
  ) {
    failures.push(
      "Plugin promotion workflow push.paths must contain promotion artifacts exactly once",
    );
  }
  if (
    !pushEvent ||
    !hasExactWorkflowEventKeys(pushEvent, ["branches", "paths"])
  ) {
    failures.push(
      "Plugin promotion workflow push must define only branches and paths",
    );
  }

  if (hasWorkflowDefaults(workflow)) {
    failures.push(
      "Plugin promotion workflow must not configure workflow-level defaults",
    );
  }

  const promotionJob = readPromotionWorkflowJob(workflow);
  if (!promotionJob) {
    failures.push(
      "Plugin promotion workflow must define verify-plugin-promotion job steps",
    );
    return;
  }
  if (promotionJob.executionModifier) {
    failures.push(
      "Plugin promotion workflow job must not use if or continue-on-error",
    );
  }
  if (promotionJob.defaults) {
    failures.push("Plugin promotion workflow job must not configure defaults");
  }
  const { steps } = promotionJob;
  const safeChainSetup = findPromotionWorkflowCommand(
    steps,
    "safe-chain setup-ci",
    "safe-chain setup after published CLI smoke",
    failures,
  );
  const npxSafeChainVerification = findPromotionWorkflowCommand(
    steps,
    "npx safe-chain-verify",
    "npx safe-chain verification",
    failures,
  );
  const bunxSafeChainVerification = findPromotionWorkflowCommand(
    steps,
    "bunx safe-chain-verify",
    "bunx safe-chain verification",
    failures,
  );
  const registryVerification = findPromotionWorkflowCommand(
    steps,
    "bun run plugin:verify:registry",
    "registry verification before recorded Codex Plugin probes",
    failures,
  );
  const publishedSmoke = findPromotionWorkflowCommand(
    steps,
    "bun run plugin:verify:published-cli",
    "published CLI smoke before recorded Codex Plugin probes",
    failures,
  );
  const runtimeReplay = findPromotionWorkflowCommand(
    steps,
    "bun run plugin:runtime:verify",
    "recorded Codex Plugin probes",
    failures,
  );
  validatePromotionCloseJob(workflow, failures);

  if (publishedSmoke === undefined) return;
  if (safeChainSetup !== undefined && publishedSmoke > safeChainSetup) {
    failures.push(
      "Plugin promotion workflow must run published CLI smoke before safe-chain setup",
    );
  }
  for (const [command, index] of [
    ["npx safe-chain verification", npxSafeChainVerification],
    ["bunx safe-chain verification", bunxSafeChainVerification],
  ]) {
    if (
      safeChainSetup !== undefined &&
      index !== undefined &&
      index < safeChainSetup
    ) {
      failures.push(
        `Plugin promotion workflow must run safe-chain setup before ${command}`,
      );
    }
  }
  if (
    registryVerification !== undefined &&
    runtimeReplay !== undefined &&
    registryVerification > runtimeReplay
  ) {
    failures.push(
      "Plugin promotion workflow must run registry verification before recorded Codex Plugin probes",
    );
  }
  if (runtimeReplay !== undefined && publishedSmoke > runtimeReplay) {
    failures.push(
      "Plugin promotion workflow must run published CLI smoke before recorded Codex Plugin probes",
    );
  }
}

function readPromotionWorkflowPaths(workflow) {
  return readPromotionWorkflowEventList(
    readPromotionWorkflowEvent(workflow, "pull_request"),
    "paths",
  );
}

function readPromotionWorkflowEvent(workflow, eventName) {
  const lines = workflow.split("\n");
  const header = `  ${eventName}:`;
  const starts = lines.reduce(
    (indices, line, index) => (line === header ? [...indices, index] : indices),
    [],
  );
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line.trim().length > 0 &&
      line.length - line.trimStart().length < 4 &&
      line.trimEnd().endsWith(":")
    ) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function readPromotionWorkflowEventList(eventLines, listName) {
  if (!eventLines) return undefined;
  const header = `    ${listName}:`;
  const starts = eventLines.reduce(
    (indices, line, index) => (line === header ? [...indices, index] : indices),
    [],
  );
  if (starts.length !== 1) return undefined;
  const start = starts[0];
  const paths = [];
  for (let index = start + 1; index < eventLines.length; index += 1) {
    const line = eventLines[index];
    if (line.trim().length === 0) continue;
    if (!line.startsWith("      - ")) break;
    const path = line.match(/^      - (?:(['"])([^#\n]+)\1|([^#\n]+))$/);
    const value = path?.[2] ?? path?.[3];
    if (!value) return undefined;
    paths.push(value.trim());
  }
  return paths.length > 0 ? paths : undefined;
}

function hasExactPromotionWorkflowPaths(paths) {
  return hasExactWorkflowList(paths, promotionWorkflowPullRequestPaths);
}

function hasExactWorkflowList(values, expectedValues) {
  const actualValues = new Set(values);
  return (
    actualValues.size === values.length &&
    values.length === expectedValues.length &&
    expectedValues.every((value) => actualValues.has(value))
  );
}

function hasExactWorkflowEventKeys(eventLines, expectedKeys) {
  const keys = eventLines.flatMap((line) => {
    const match = line.match(/^    ([A-Za-z0-9_-]+):\s*$/);
    return match?.[1] ? [match[1]] : [];
  });
  return hasExactWorkflowList(keys, expectedKeys);
}

function hasWorkflowDefaults(workflow) {
  return workflow
    .split("\n")
    .some((line) => hasWorkflowMappingKey(line, 0, ["defaults"]));
}

function hasWorkflowMappingKey(line, indentation, keys) {
  const keyPattern = keys.join("|");
  return new RegExp(
    `^${" ".repeat(indentation)}(?:${keyPattern}|["'](?:${keyPattern})["'])\\s*:`,
  ).test(line);
}

function hasWorkflowListMappingKey(line, indentation, keys) {
  const keyPattern = keys.join("|");
  return new RegExp(
    `^${" ".repeat(indentation)}-\\s+(?:${keyPattern}|["'](?:${keyPattern})["'])\\s*:`,
  ).test(line);
}

function readPromotionWorkflowJob(
  workflow,
  jobName = "verify-plugin-promotion",
) {
  const lines = workflow.split("\n");
  const jobStart = lines.indexOf(`  ${jobName}:`);
  if (jobStart === -1) return undefined;

  let jobEnd = lines.length;
  for (let index = jobStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      line.startsWith("  ") &&
      !line.startsWith("    ") &&
      line.trimEnd().endsWith(":")
    ) {
      jobEnd = index;
      break;
    }
  }

  let stepsStart = -1;
  for (let index = jobStart + 1; index < jobEnd; index += 1) {
    if (lines[index] === "    steps:") {
      stepsStart = index;
      break;
    }
  }
  if (stepsStart === -1) return undefined;

  const jobLines = lines.slice(jobStart + 1, jobEnd);
  const steps = [];
  for (let index = stepsStart + 1; index < jobEnd;) {
    if (!lines[index].startsWith("      - ")) {
      index += 1;
      continue;
    }
    let nextStep = index + 1;
    while (nextStep < jobEnd && !lines[nextStep].startsWith("      - ")) {
      nextStep += 1;
    }
    const stepLines = lines.slice(index, nextStep);
    const run = stepLines
      .map((line) => line.match(/^        run:\s*(.+)$/)?.[1]?.trim())
      .find((value) => value && value !== "|" && value !== ">");
    const uses = stepLines
      .map((line) => line.match(/^        uses:\s*(.+)$/)?.[1]?.trim())
      .find(Boolean);
    const executionModifier = stepLines.some(
      (line) =>
        hasWorkflowListMappingKey(
          line,
          6,
          promotionStepExecutionModifierKeys,
        ) || hasWorkflowMappingKey(line, 8, promotionStepExecutionModifierKeys),
    );
    steps.push({
      lines: stepLines,
      run,
      uses,
      executionModifier,
      workingDirectory: stepLines.some((line) =>
        hasWorkflowMappingKey(line, 8, ["working-directory"]),
      ),
    });
    index = nextStep;
  }
  return {
    jobLines,
    steps,
    executionModifier: jobLines.some((line) =>
      hasWorkflowMappingKey(line, 4, promotionJobExecutionModifierKeys),
    ),
    defaults: jobLines.some((line) =>
      hasWorkflowMappingKey(line, 4, ["defaults"]),
    ),
  };
}

function validatePromotionCloseJob(workflow, failures) {
  const jobHeader = "  close-promotion-reminders:";
  const jobCount = workflow
    .split("\n")
    .filter((line) => line === jobHeader).length;
  if (jobCount !== 1) {
    failures.push(
      "Plugin promotion workflow must define close-promotion-reminders exactly once",
    );
    return;
  }

  const closeJob = readPromotionWorkflowJob(
    workflow,
    "close-promotion-reminders",
  );
  if (!closeJob) {
    failures.push(
      "Plugin promotion workflow must define close-promotion-reminders job steps",
    );
    return;
  }

  if (
    readPromotionWorkflowJobScalar(closeJob.jobLines, "needs") !==
    "verify-plugin-promotion"
  ) {
    failures.push(
      "Plugin promotion close job needs must equal verify-plugin-promotion",
    );
  }
  if (
    readPromotionWorkflowJobScalar(closeJob.jobLines, "if") !==
    promotionCloseJobCondition
  ) {
    failures.push(
      "Plugin promotion close job if must allow only main push or main workflow_dispatch",
    );
  }
  if (
    !isDeepStrictEqual(readPromotionWorkflowJobPermissions(closeJob.jobLines), {
      contents: "read",
      issues: "write",
    })
  ) {
    failures.push(
      "Plugin promotion close job permissions must contain only contents read and issues write",
    );
  }
  if (
    closeJob.jobLines.some((line) =>
      hasWorkflowMappingKey(line, 4, ["continue-on-error"]),
    )
  ) {
    failures.push("Plugin promotion close job must not use continue-on-error");
  }
  if (closeJob.defaults) {
    failures.push("Plugin promotion close job must not configure defaults");
  }
  if (
    closeJob.jobLines.some((line) =>
      hasWorkflowMappingKey(line, 4, ["container"]),
    )
  ) {
    failures.push("Plugin promotion close job must not configure a container");
  }
  if (
    closeJob.jobLines.some((line) => hasWorkflowMappingKey(line, 4, ["env"]))
  ) {
    failures.push(
      "Plugin promotion close job must not configure job-level env",
    );
  }

  const reconcile = findPromotionWorkflowCommand(
    closeJob.steps,
    "node scripts/plugin-promotion-issues.mjs",
    "promotion reminder reconciliation",
    failures,
  );
  if (reconcile !== undefined && closeJob.steps[reconcile]?.workingDirectory) {
    failures.push(
      "Plugin promotion workflow must run promotion reminder reconciliation without working-directory",
    );
  }

  const [checkoutStep, setupNodeStep, reconcileStep] = closeJob.steps;
  if (
    closeJob.steps.length !== 3 ||
    stripWorkflowComment(checkoutStep?.uses) !==
      "actions/checkout@" + "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" ||
    !checkoutStep.lines.includes("          persist-credentials: false") ||
    stripWorkflowComment(setupNodeStep?.uses) !==
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" ||
    !setupNodeStep.lines.includes('          node-version: "24"') ||
    reconcileStep?.run !== "node scripts/plugin-promotion-issues.mjs"
  ) {
    failures.push(
      "Plugin promotion close job steps must be checkout, Node 24 setup, and reconciliation only",
    );
  }
  if (
    !isDeepStrictEqual(
      readPromotionWorkflowStepEnvironment(reconcileStep?.lines),
      {
        GH_TOKEN: "${{ github.token }}",
      },
    ) ||
    closeJob.jobLines.filter((line) => line.includes("GH_TOKEN:")).length !== 1
  ) {
    failures.push(
      "Plugin promotion reconciliation step must receive only GH_TOKEN from github.token",
    );
  }
}

function readPromotionWorkflowJobScalar(jobLines, key) {
  const pattern = new RegExp(`^    ${key}:\\s*(.*)$`);
  const starts = jobLines.reduce((matches, line, index) => {
    const match = line.match(pattern);
    return match ? [...matches, { index, value: match[1].trim() }] : matches;
  }, []);
  if (starts.length !== 1) return undefined;
  const [{ index, value }] = starts;
  const parts = [value];
  if (value === ">-" || value === ">" || value === "|" || value === "|-") {
    for (
      let lineIndex = index + 1;
      lineIndex < jobLines.length;
      lineIndex += 1
    ) {
      const line = jobLines[lineIndex];
      if (
        line.trim().length > 0 &&
        line.length - line.trimStart().length <= 4
      ) {
        break;
      }
      if (line.trim().length > 0) parts.push(line.trim());
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function readPromotionWorkflowJobPermissions(jobLines) {
  return readPromotionWorkflowMapping(jobLines, 4, 6, "permissions");
}

function readPromotionWorkflowStepEnvironment(stepLines) {
  if (!stepLines) return undefined;
  return readPromotionWorkflowMapping(stepLines, 8, 10, "env");
}

function readPromotionWorkflowMapping(
  lines,
  keyIndentation,
  valueIndentation,
  key,
) {
  const header = `${" ".repeat(keyIndentation)}${key}:`;
  const starts = lines.reduce(
    (indices, line, index) => (line === header ? [...indices, index] : indices),
    [],
  );
  if (starts.length !== 1) return undefined;
  const entries = {};
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    if (line.length - line.trimStart().length <= keyIndentation) break;
    const match = line.match(
      new RegExp(`^${" ".repeat(valueIndentation)}([A-Za-z0-9_-]+):\\s*(.+)$`),
    );
    if (!match?.[1] || !match[2] || match[1] in entries) return undefined;
    entries[match[1]] = match[2].trim();
  }
  return entries;
}

function stripWorkflowComment(value) {
  return value?.replace(/\s+#.*$/, "");
}

function findPromotionWorkflowCommand(steps, command, description, failures) {
  const matches = steps.reduce(
    (indices, step, index) =>
      step.run === command
        ? [...indices, { index, executionModifier: step.executionModifier }]
        : indices,
    [],
  );
  if (matches.length !== 1) {
    failures.push(
      `Plugin promotion workflow must run ${description} exactly once`,
    );
    return undefined;
  }
  const match = matches[0];
  if (match.executionModifier) {
    failures.push(
      `Plugin promotion workflow must run ${description} without if, continue-on-error, or shell`,
    );
    return undefined;
  }
  return match.index;
}

function validatePluginMcpInvocation(server, label, failures) {
  if (server.command !== "npx") {
    failures.push(`${label} command must be "npx"`);
  }
  if (!Array.isArray(server.args)) {
    failures.push(
      `${label} args must be ["-y", "--package=@kyo-so/cli@VERSION", "kyoso", "mcp"]`,
    );
    return { packageName: "", packageVersion: "" };
  }
  const pin = parsePluginMcpPackagePin(server.args);
  if (!pin) {
    failures.push(
      `${label} package pin must be an exact @kyo-so/cli SemVer; args[1] was ${formatValue(server.args[1])}`,
    );
    failures.push(
      `${label} args must be ["-y", "--package=@kyo-so/cli@VERSION", "kyoso", "mcp"]`,
    );
    return { packageName: "", packageVersion: "" };
  }
  const expectedArgs = buildPluginMcpArgs(packagePin(pin));
  if (!isDeepStrictEqual(server.args, expectedArgs)) {
    failures.push(
      `${label} args must exactly equal ${formatValue(expectedArgs)}; received ${formatValue(server.args)}`,
    );
    failures.push(
      `${label} args must be ["-y", "--package=@kyo-so/cli@VERSION", "kyoso", "mcp"]`,
    );
  }
  return pin;
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
  } else {
    const versions = new Set();
    for (const probe of compatibility.probes) {
      if (!isNonEmptyString(probe?.codexVersion)) {
        failures.push(
          "Plugin compatibility record probes must have a non-empty codexVersion",
        );
        continue;
      }
      if (versions.has(probe.codexVersion)) {
        failures.push(
          `Plugin compatibility record must not duplicate Codex ${probe.codexVersion}`,
        );
      }
      versions.add(probe.codexVersion);
      if (probe.fixtureSchemaVersion !== compatibility.schemaVersion) {
        failures.push(
          `Plugin compatibility probe ${probe.codexVersion} fixtureSchemaVersion must match schemaVersion`,
        );
      }
    }
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
  if (contract?.distribution?.mcpExecutable !== pluginMcpServerName) {
    failures.push(
      `Plugin compatibility contract distribution.mcpExecutable must be ${pluginMcpServerName}`,
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

function parsePluginMcpPackagePin(args) {
  const packageArgument = args?.[1];
  if (
    !isNonEmptyString(packageArgument) ||
    !packageArgument.startsWith(pluginMcpPackageArgumentPrefix)
  ) {
    return undefined;
  }
  return parsePackagePin(
    packageArgument.slice(pluginMcpPackageArgumentPrefix.length),
  );
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
  const pin = parsePluginMcpPackagePin(mcp?.[pluginMcpServerName]?.args);
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

function isExactStringRecord(value, expected) {
  return (
    isStringRecord(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, expectedValue]) =>
        Object.hasOwn(value, key) && value[key] === expectedValue,
    )
  );
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
