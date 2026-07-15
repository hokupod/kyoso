import { access, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { stderr, stdin } from "node:process";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { defaultConfig } from "./defaultConfig.js";
import { flattenLeaves, mergeProjectTomlConfig } from "./projectScope.js";
import {
  CODEX_DEFAULT_PROVIDER,
  CODEX_OPENROUTER_PROVIDER,
  kyosoConfigKnownLeafPaths,
  kyosoConfigRecordPrefixes,
  kyosoConfigSecuritySensitivePrefixes,
  kyosoConfigSchema,
  type KyosoConfig,
} from "./schema.js";
import { sanitizeText } from "../security/sanitizeText.js";
import { loadTomlConfigFile } from "./tomlConfigLoader.js";
import { loadConfigModule } from "./tsConfigLoader.js";
import {
  defaultTrustedConfigStorePath,
  hashConfigSource,
  isTrustedConfig,
  trustConfig,
  type ConfigTrustStatus,
} from "./trustedConfig.js";

export type LoadConfigOptions = {
  cwd?: string;
  configPath?: string;
  ignoreConfig?: boolean;
  trustConfig?: boolean;
  allowUnknownConfig?: boolean;
  promptForTrust?: boolean;
  trustStorePath?: string;
  env?: NodeJS.ProcessEnv;
  trustPrompt?: (config: {
    configPath: string;
    configHash: string;
  }) => Promise<boolean>;
};

export type LoadedConfigSource = {
  path: string;
  layer: "global_toml" | "project_toml" | "project_ts";
};

export type LoadedConfig = {
  config: KyosoConfig;
  configPath?: string;
  configHash?: string;
  configTrustStatus: ConfigTrustStatus;
  sources: LoadedConfigSource[];
  warnings: string[];
};

type ProjectConfigIdentity = {
  requestedPath: string;
  canonicalPath: string;
  canonicalDirectory: string;
};

export type ConfigValidationContext = {
  source?: LoadedConfigSource;
  projectTsExecuted: boolean;
};

const configValidationContexts = new WeakMap<
  z.ZodError,
  ConfigValidationContext
>();

export function getConfigValidationContext(
  error: unknown,
): ConfigValidationContext | undefined {
  return error instanceof z.ZodError
    ? configValidationContexts.get(error)
    : undefined;
}

export class ProjectOpenRouterAuthorizationError extends Error {
  readonly code = "PROJECT_OPENROUTER_AUTHORIZATION_REQUIRED";
  readonly projectPath: string;
  readonly projectDirectory: string;
  readonly layer: "project_toml" | "project_ts";
  readonly globalConfigPath: string;

  constructor(input: {
    projectPath: string;
    projectDirectory: string;
    layer: "project_toml" | "project_ts";
    globalConfigPath: string;
  }) {
    const projectPath = sanitizeWarningText(input.projectPath);
    const projectDirectory = sanitizeWarningText(input.projectDirectory);
    const globalConfigPath = sanitizeWarningText(input.globalConfigPath);
    super(
      `Project config ${projectPath} changes Codex OpenRouter routing, but its directory ${projectDirectory} is not in the user-global allowlist. Add ${JSON.stringify(projectDirectory)} to agents.codex.allowProjectProvider in ${globalConfigPath} to permit project-level external provider routing.`,
    );
    this.name = "ProjectOpenRouterAuthorizationError";
    this.projectPath = projectPath;
    this.projectDirectory = projectDirectory;
    this.layer = input.layer;
    this.globalConfigPath = globalConfigPath;
  }
}

const KNOWN_GLOBAL_CONFIG_LEAF_PATHS = new Set(kyosoConfigKnownLeafPaths);
const GLOBAL_CONFIG_RECORD_PREFIXES = kyosoConfigRecordPrefixes.map((path) =>
  path.split("."),
);
const SECURITY_SENSITIVE_GLOBAL_PREFIXES =
  kyosoConfigSecuritySensitivePrefixes.map((path) => path.split("."));

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const globalConfigPath = resolveGlobalTomlConfigPath(env);
  const warnings: string[] = [];
  const sources: LoadedConfigSource[] = [];
  let mergedConfig: unknown = defaultConfig;
  let configPath: string | undefined;
  let configHash: string | undefined;
  let configTrustStatus: ConfigTrustStatus = options.ignoreConfig
    ? "ignored"
    : "not_found";

  if (!options.ignoreConfig) {
    if (await exists(globalConfigPath)) {
      const globalConfig = await loadTomlConfigFile(globalConfigPath);
      const globalConfigWarnings = collectGlobalConfigWarnings(
        globalConfigPath,
        globalConfig,
      );
      const securitySensitiveWarnings = globalConfigWarnings.filter((warning) =>
        warning.startsWith("security-sensitive unknown settings "),
      );
      if (securitySensitiveWarnings.length > 0 && !options.allowUnknownConfig) {
        throw new Error(
          `Security-sensitive unknown config settings rejected. Fix the key name or pass --allow-unknown-config to continue with warnings: ${securitySensitiveWarnings.join("; ")}`,
        );
      }
      warnings.push(...globalConfigWarnings);
      mergedConfig = deepMerge(mergedConfig, globalConfig);
      sources.push({ path: globalConfigPath, layer: "global_toml" });
    }

    if (options.configPath) {
      const explicitConfigPath = resolve(cwd, options.configPath);
      const projectConfig =
        await resolveProjectConfigIdentity(explicitConfigPath);
      if (!projectConfig) {
        throw new Error(
          `Config file not found: ${explicitConfigPath} (from --config)`,
        );
      }
      const loaded = await loadProjectConfig({
        projectConfig,
        baseConfig: mergedConfig,
        globalConfigPath,
        options,
      });
      mergedConfig = loaded.mergedConfig;
      configPath = loaded.configPath;
      configHash = loaded.configHash;
      configTrustStatus = loaded.configTrustStatus;
      sources.push(loaded.source);
      warnings.push(...loaded.warnings);
    } else {
      const projectTomlPath = resolve(cwd, "kyoso.toml");
      const projectTsPath = resolve(cwd, "kyoso.config.ts");
      const projectToml = await resolveProjectConfigIdentity(projectTomlPath);
      const projectTs = await resolveProjectConfigIdentity(projectTsPath);
      if (projectToml) {
        const loaded = await loadProjectConfig({
          projectConfig: projectToml,
          baseConfig: mergedConfig,
          globalConfigPath,
          options,
        });
        mergedConfig = loaded.mergedConfig;
        configPath = loaded.configPath;
        configHash = loaded.configHash;
        configTrustStatus = loaded.configTrustStatus;
        sources.push(loaded.source);
        warnings.push(...loaded.warnings);
        if (projectTs) {
          warnings.push(
            `kyoso.config.ts was ignored because kyoso.toml takes precedence: ${projectTsPath}`,
          );
        }
      } else if (projectTs) {
        const loaded = await loadProjectTsConfig({
          projectConfig: projectTs,
          baseConfig: mergedConfig,
          globalConfigPath,
          options,
        });
        mergedConfig = loaded.mergedConfig;
        configPath = loaded.configPath;
        configHash = loaded.configHash;
        configTrustStatus = loaded.configTrustStatus;
        sources.push(loaded.source);
        warnings.push(...loaded.warnings);
      }
    }
  }

  const parsed = kyosoConfigSchema.safeParse(mergedConfig);
  if (!parsed.success) {
    const source = sources.at(-1);
    configValidationContexts.set(parsed.error, {
      source,
      projectTsExecuted:
        source?.layer === "project_ts" &&
        isTrustedProjectConfigExecution(configTrustStatus),
    });
    throw parsed.error;
  }
  return {
    config: parsed.data,
    configPath,
    configHash,
    configTrustStatus,
    sources,
    warnings,
  };
}

export function resolveGlobalTomlConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = env.XDG_CONFIG_HOME
    ? resolve(env.XDG_CONFIG_HOME)
    : join(env.HOME ? resolve(env.HOME) : homedir(), ".config");
  return join(configHome, "kyoso", "config.toml");
}

function collectGlobalConfigWarnings(
  configPath: string,
  config: unknown,
): string[] {
  // Global config stays warning-only for forward compatibility across versions.
  // Project TOML remains fail-closed because it is repository-owned policy.
  const unknownSettings = flattenLeaves(config)
    .map((leaf) => leaf.path)
    .filter((path) => !isKnownGlobalConfigPath(path))
    .map((path) => ({
      path: sanitizeWarningText(path.join(".")),
      securitySensitive: isSecuritySensitiveGlobalPath(path),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const warnings: string[] = [];
  const securitySensitivePaths = unknownSettings
    .filter((setting) => setting.securitySensitive)
    .map((setting) => setting.path);
  const generalPaths = unknownSettings
    .filter((setting) => !setting.securitySensitive)
    .map((setting) => setting.path);
  const sanitizedConfigPath = sanitizeWarningText(configPath);
  if (securitySensitivePaths.length > 0) {
    warnings.push(
      `security-sensitive unknown settings in ${sanitizedConfigPath} were ignored: ${formatUnknownPaths(securitySensitivePaths)}`,
    );
  }
  if (generalPaths.length > 0) {
    warnings.push(
      `unknown settings in ${sanitizedConfigPath} were ignored: ${formatUnknownPaths(generalPaths)}`,
    );
  }
  return warnings;
}

function sanitizeWarningText(value: string): string {
  const withoutControlChars = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return sanitizeText(withoutControlChars);
}

function formatUnknownPaths(paths: string[]): string {
  return paths.map((path) => JSON.stringify(path)).join("; ");
}

function isSecuritySensitiveGlobalPath(path: string[]): boolean {
  return SECURITY_SENSITIVE_GLOBAL_PREFIXES.some((prefix) =>
    pathStartsWith(path, prefix),
  );
}

function isKnownGlobalConfigPath(path: string[]): boolean {
  if (KNOWN_GLOBAL_CONFIG_LEAF_PATHS.has(path.join("."))) return true;
  return GLOBAL_CONFIG_RECORD_PREFIXES.some((prefix) =>
    pathStartsWith(path, prefix),
  );
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  return (
    path.length >= prefix.length &&
    prefix.every((part, index) => path[index] === part)
  );
}

async function loadProjectConfig(input: {
  projectConfig: ProjectConfigIdentity;
  baseConfig: unknown;
  globalConfigPath: string;
  options: LoadConfigOptions;
}): Promise<{
  mergedConfig: unknown;
  configPath: string;
  configHash?: string;
  configTrustStatus: ConfigTrustStatus;
  source: LoadedConfigSource;
  warnings: string[];
}> {
  const { canonicalDirectory, canonicalPath, requestedPath } =
    input.projectConfig;
  const extension = extname(requestedPath);
  if (extension === ".toml") {
    const projectTomlConfig = await loadTomlConfigFile(canonicalPath);
    const projectChangesOpenRouterRoute = projectConfigChangesOpenRouterRoute(
      projectTomlConfig,
      input.baseConfig,
    );
    await assertProjectOpenRouterAuthorization({
      projectConfig: projectTomlConfig,
      projectPath: requestedPath,
      projectDirectory: canonicalDirectory,
      layer: "project_toml",
      baseConfig: input.baseConfig,
      globalConfigPath: input.globalConfigPath,
    });
    const projectMergedConfig = mergeProjectTomlConfig(
      input.baseConfig,
      projectTomlConfig,
      {
        projectPath: requestedPath,
        globalConfigPath: input.globalConfigPath,
      },
    );
    return {
      mergedConfig: applyProjectCodexProviderReset(
        input.baseConfig,
        projectTomlConfig,
        projectMergedConfig,
      ),
      configPath: requestedPath,
      configTrustStatus: "not_found",
      source: { path: requestedPath, layer: "project_toml" },
      warnings: projectChangesOpenRouterRoute
        ? [openRouterProjectConfigWarning(requestedPath)]
        : [],
    };
  }
  if (extension === ".ts") {
    return await loadProjectTsConfig(input);
  }
  throw new Error(
    `Unsupported config file extension for ${requestedPath}. Expected .toml or .ts.`,
  );
}

function projectConfigSelectsOpenRouter(config: unknown): boolean {
  return flattenLeaves(config).some(
    (leaf) =>
      leaf.path.join(".") === "agents.codex.provider" &&
      leaf.value === CODEX_OPENROUTER_PROVIDER,
  );
}

function projectConfigSelectsDefaultProvider(config: unknown): boolean {
  return flattenLeaves(config).some(
    (leaf) =>
      leaf.path.join(".") === "agents.codex.provider" &&
      leaf.value === CODEX_DEFAULT_PROVIDER,
  );
}

function projectConfigSuppliesCodexModel(config: unknown): boolean {
  return flattenLeaves(config).some(
    (leaf) => leaf.path.join(".") === "agents.codex.model",
  );
}

function projectConfigChangesOpenRouterRoute(
  projectConfig: unknown,
  baseConfig: unknown,
): boolean {
  return (
    projectConfigSelectsOpenRouter(projectConfig) ||
    (configSelectsOpenRouter(baseConfig) &&
      projectConfigSuppliesCodexModel(projectConfig) &&
      !projectConfigSelectsDefaultProvider(projectConfig))
  );
}

function configSelectsOpenRouter(config: unknown): boolean {
  return flattenLeaves(config).some(
    (leaf) =>
      leaf.path.join(".") === "agents.codex.provider" &&
      leaf.value === CODEX_OPENROUTER_PROVIDER,
  );
}

export function applyProjectCodexProviderReset(
  baseConfig: unknown,
  projectConfig: unknown,
  mergedConfig: unknown,
): unknown {
  if (
    !projectConfigSelectsDefaultProvider(projectConfig) ||
    projectConfigSuppliesCodexModel(projectConfig) ||
    !configSelectsOpenRouter(baseConfig) ||
    !isRecord(mergedConfig) ||
    !isRecord(mergedConfig.agents) ||
    !isRecord(mergedConfig.agents.codex)
  ) {
    return mergedConfig;
  }

  const codexWithoutInheritedModel = Object.fromEntries(
    Object.entries(mergedConfig.agents.codex).filter(
      ([key]) => key !== "model",
    ),
  );
  return {
    ...mergedConfig,
    agents: {
      ...mergedConfig.agents,
      codex: codexWithoutInheritedModel,
    },
  };
}

function openRouterProjectConfigWarning(configPath: string): string {
  return `Project config ${sanitizeWarningText(configPath)} changes Codex OpenRouter routing under user-global authorization; it can route Codex review content through OpenRouter.`;
}

async function assertProjectOpenRouterAuthorization(input: {
  projectConfig: unknown;
  projectPath: string;
  projectDirectory: string;
  layer: "project_toml" | "project_ts";
  baseConfig: unknown;
  globalConfigPath: string;
}): Promise<void> {
  if (
    !projectConfigChangesOpenRouterRoute(input.projectConfig, input.baseConfig)
  ) {
    return;
  }

  if (
    await projectProviderIsAuthorized(input.baseConfig, input.projectDirectory)
  ) {
    return;
  }

  throw new ProjectOpenRouterAuthorizationError({
    projectPath: input.projectPath,
    projectDirectory: input.projectDirectory,
    layer: input.layer,
    globalConfigPath: input.globalConfigPath,
  });
}

async function projectProviderIsAuthorized(
  config: unknown,
  projectDirectory: string,
): Promise<boolean> {
  if (!isRecord(config)) return false;
  const agents = config.agents;
  if (!isRecord(agents)) return false;
  const codex = agents.codex;
  if (!isRecord(codex) || !Array.isArray(codex.allowProjectProvider)) {
    return false;
  }

  for (const directory of codex.allowProjectProvider) {
    if (typeof directory !== "string" || !isAbsolute(directory)) continue;
    const allowedDirectory = await existingRealpath(directory);
    if (allowedDirectory === projectDirectory) return true;
  }
  return false;
}

async function resolveProjectConfigIdentity(
  requestedPath: string,
): Promise<ProjectConfigIdentity | undefined> {
  const canonicalPath = await existingRealpath(requestedPath);
  return canonicalPath === undefined
    ? undefined
    : {
        requestedPath,
        canonicalPath,
        canonicalDirectory: dirname(canonicalPath),
      };
}

async function existingRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

async function loadProjectTsConfig(input: {
  projectConfig: ProjectConfigIdentity;
  baseConfig: unknown;
  globalConfigPath: string;
  options: LoadConfigOptions;
}): Promise<{
  mergedConfig: unknown;
  configPath: string;
  configHash?: string;
  configTrustStatus: ConfigTrustStatus;
  source: LoadedConfigSource;
  warnings: string[];
}> {
  const { canonicalDirectory, canonicalPath, requestedPath } =
    input.projectConfig;
  const warnings = [
    'kyoso.config.ts is deprecated; migrate to kyoso.toml (see README "Configuration")',
  ];
  const source = await readFile(canonicalPath, "utf8");
  const configHash = hashConfigSource(source);
  const trustStorePath =
    input.options.trustStorePath ??
    defaultTrustedConfigStorePath(input.options.env);
  const trusted = await isTrustedConfig(
    trustStorePath,
    canonicalPath,
    configHash,
  );
  const trustDecision = await resolveTrustDecision({
    configPath: requestedPath,
    configHash,
    trusted,
    options: input.options,
  });

  if (trustDecision.execute) {
    const userConfig = await loadUserConfig(canonicalPath, source);
    const projectChangesOpenRouterRoute = projectConfigChangesOpenRouterRoute(
      userConfig,
      input.baseConfig,
    );
    await assertProjectOpenRouterAuthorization({
      projectConfig: userConfig,
      projectPath: requestedPath,
      projectDirectory: canonicalDirectory,
      layer: "project_ts",
      baseConfig: input.baseConfig,
      globalConfigPath: input.globalConfigPath,
    });
    if (trustDecision.shouldPersist) {
      await trustConfig(trustStorePath, canonicalPath, configHash);
    }
    const projectMergedConfig = deepMerge(input.baseConfig, userConfig);
    if (projectChangesOpenRouterRoute) {
      warnings.push(openRouterProjectConfigWarning(requestedPath));
    }
    return {
      mergedConfig: applyProjectCodexProviderReset(
        input.baseConfig,
        userConfig,
        projectMergedConfig,
      ),
      configPath: requestedPath,
      configHash,
      configTrustStatus: trustDecision.status,
      source: { path: requestedPath, layer: "project_ts" },
      warnings,
    };
  }

  warnings.push(
    `untrusted config was not executed: ${requestedPath}; run \`kyoso doctor --trust-config\` or pass \`--trust-config\` once to trust it`,
  );
  return {
    mergedConfig: input.baseConfig,
    configPath: requestedPath,
    configHash,
    configTrustStatus: trustDecision.status,
    source: { path: requestedPath, layer: "project_ts" },
    warnings,
  };
}

function isTrustedProjectConfigExecution(status: ConfigTrustStatus): boolean {
  return (
    status === "trusted" ||
    status === "trusted_by_flag" ||
    status === "trusted_interactively"
  );
}

async function loadUserConfig(
  configPath: string,
  source: string,
): Promise<unknown> {
  try {
    const loaded = await loadConfigModule(configPath, source);
    return loaded.default ?? loaded.config ?? {};
  } catch (error) {
    throw new Error(
      `Config load failed for ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function resolveTrustDecision(input: {
  configPath: string;
  configHash: string;
  trusted: boolean;
  options: LoadConfigOptions;
}): Promise<{
  execute: boolean;
  shouldPersist: boolean;
  status: ConfigTrustStatus;
}> {
  if (input.trusted) {
    return { execute: true, shouldPersist: false, status: "trusted" };
  }
  if (input.options.trustConfig) {
    return { execute: true, shouldPersist: true, status: "trusted_by_flag" };
  }
  if (input.options.promptForTrust) {
    const approved = input.options.trustPrompt
      ? await input.options.trustPrompt({
          configPath: input.configPath,
          configHash: input.configHash,
        })
      : await promptForConfigTrust(input.configPath, input.configHash);
    if (approved) {
      return {
        execute: true,
        shouldPersist: true,
        status: "trusted_interactively",
      };
    }
  }
  return { execute: false, shouldPersist: false, status: "untrusted_skipped" };
}

async function promptForConfigTrust(
  configPath: string,
  configHash: string,
): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    stderr.write(
      [
        "Kyoso config is not trusted.",
        `  path: ${configPath}`,
        `  sha256: ${configHash}`,
      ].join("\n") + "\n",
    );
    const answer = await rl.question("Trust and execute this config? [y/N] ");
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override ?? base;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
