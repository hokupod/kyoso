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
const pluginOpenAiMetadataRelativePath = "agents/openai.yaml";
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

export function distributionPaths(root = repositoryRoot) {
  return {
    root,
    catalog: join(root, ".agents", "plugins", "marketplace.json"),
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
    mcp: join(root, pluginRootRelativePath, ".mcp.json"),
    pluginRoot: join(root, pluginRootRelativePath),
    pluginSkill: join(root, pluginSkillRelativePath),
    runtimeContract: join(root, "src", "cli", "pluginRuntimeContract.ts"),
  };
}

/**
 * Apply the Plugin-only Skill metadata contract to canonical Skill content.
 * The canonical Skill remains MCP-optional for skill-only installation.
 */
function transformCanonicalToPlugin(relativePath, content) {
  if (relativePath !== pluginOpenAiMetadataRelativePath) return content;

  const metadata = content.toString("utf8");
  if (metadata.endsWith(`${pluginMcpDependencyBlock}\n`)) return content;
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
  const catalog = readJson(paths.catalog, "Marketplace catalog", failures);
  const manifest = readJson(paths.manifest, "Plugin manifest", failures);
  const mcp = readJson(paths.mcp, "Plugin MCP config", failures);
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
  validateDistributionSafety({ catalog, manifest, mcp }, failures);
  validatePackageAllowlist(packageMetadata, failures);
  validatePackageVersion(
    packageMetadata,
    pin,
    failures,
    expectedPackageVersion,
  );
  validateSkillMirror(paths, failures);
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
  const { canonicalSkill, pluginSkill } = distributionPaths(root);
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
    applyCanonicalPluginTransforms(canonicalSkill, stage);
    assertSkillDirectoriesEqual(canonicalSkill, stage);

    if (existsSync(pluginSkill)) {
      renameSync(pluginSkill, backup);
      movedExisting = true;
    }
    renameSync(stage, pluginSkill);
    installed = true;
    options.afterInstall?.({ canonicalSkill, pluginSkill });
    assertSkillDirectoriesEqual(canonicalSkill, pluginSkill);
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
  const { canonicalSkill, pluginSkill } = distributionPaths(root);
  assertSkillDirectoriesEqual(canonicalSkill, pluginSkill);
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
    failures.push("Plugin manifest mcpServers must resolve to ./.mcp.json");
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
  const forbidden = ["plugins", ".agents/plugins"];
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
}

function validateSkillMirror(paths, failures) {
  try {
    const sourceDigest = hashSkillDirectory(paths.canonicalSkill);
    const mirrorDigest = hashSkillDirectory(paths.pluginSkill);
    const expectedPluginDigest = hashTransformedPluginSkillDirectory(
      paths.canonicalSkill,
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
    assertSkillDirectoriesEqual(paths.canonicalSkill, paths.pluginSkill);
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

function assertPackageArchiveExcludesPluginPaths(root) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "kyoso-plugin-pack-"));
  try {
    const result = spawnSync(
      "npm",
      [
        "--cache",
        join(cacheRoot, "npm-cache"),
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000,
      },
    );
    if (result.error) {
      throw new Error(`npm pack --dry-run failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `npm pack --dry-run failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const metadata = parseNpmPackJson(result.stdout);
    const paths = metadata.files.map((file) => file.path);
    for (const prefix of ["plugins/", ".agents/plugins/"]) {
      if (paths.some((path) => path.startsWith(prefix))) {
        throw new Error(
          `npm pack dry-run includes forbidden Plugin path: ${prefix}`,
        );
      }
    }
  } finally {
    rmSync(cacheRoot, { force: true, recursive: true });
  }
}

function parseNpmPackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("npm pack --dry-run did not emit JSON metadata");
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  const metadata = parsed[0];
  if (!Array.isArray(metadata?.files)) {
    throw new Error("npm pack --dry-run metadata is missing files");
  }
  return metadata;
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

function hashTransformedPluginSkillDirectory(directory) {
  return hashSkillFiles(
    listSkillFiles(directory, { includeMarker: false }).map((file) => ({
      ...file,
      contents: transformCanonicalToPlugin(file.relativePath, file.contents),
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

function assertSkillDirectoriesEqual(source, mirror) {
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

function applyCanonicalPluginTransforms(source, destination) {
  for (const file of listSkillFiles(source, { includeMarker: true })) {
    const transformed = transformCanonicalToPlugin(
      file.relativePath,
      file.contents,
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

function packagePin(pin) {
  return pin.packageName ? `${pin.packageName}@${pin.packageVersion}` : "";
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
    if (isForbiddenDistributionKey(normalizeDistributionKey(key))) {
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
