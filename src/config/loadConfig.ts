import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { stderr, stdin } from "node:process";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultConfig } from "./defaultConfig.js";
import { mergeProjectTomlConfig } from "./projectScope.js";
import { kyosoConfigSchema, type KyosoConfig } from "./schema.js";
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
      mergedConfig = deepMerge(
        mergedConfig,
        await loadTomlConfigFile(globalConfigPath),
      );
      sources.push({ path: globalConfigPath, layer: "global_toml" });
    }

    if (options.configPath) {
      const explicitConfigPath = resolve(cwd, options.configPath);
      if (await exists(explicitConfigPath)) {
        const loaded = await loadProjectConfig({
          configPath: explicitConfigPath,
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
    } else {
      const projectTomlPath = resolve(cwd, "kyoso.toml");
      const projectTsPath = resolve(cwd, "kyoso.config.ts");
      const hasProjectToml = await exists(projectTomlPath);
      const hasProjectTs = await exists(projectTsPath);
      if (hasProjectToml) {
        mergedConfig = mergeProjectTomlConfig(
          mergedConfig,
          await loadTomlConfigFile(projectTomlPath),
          { projectPath: projectTomlPath, globalConfigPath },
        );
        configPath = projectTomlPath;
        sources.push({ path: projectTomlPath, layer: "project_toml" });
        if (hasProjectTs) {
          warnings.push(
            `kyoso.config.ts was ignored because kyoso.toml takes precedence: ${projectTsPath}`,
          );
        }
      } else if (hasProjectTs) {
        const loaded = await loadProjectTsConfig({
          configPath: projectTsPath,
          baseConfig: mergedConfig,
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

  const parsed = kyosoConfigSchema.parse(mergedConfig);
  return {
    config: parsed,
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

async function loadProjectConfig(input: {
  configPath: string;
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
  const extension = extname(input.configPath);
  if (extension === ".toml") {
    return {
      mergedConfig: mergeProjectTomlConfig(
        input.baseConfig,
        await loadTomlConfigFile(input.configPath),
        {
          projectPath: input.configPath,
          globalConfigPath: input.globalConfigPath,
        },
      ),
      configPath: input.configPath,
      configTrustStatus: "not_found",
      source: { path: input.configPath, layer: "project_toml" },
      warnings: [],
    };
  }
  if (extension === ".ts") {
    return await loadProjectTsConfig(input);
  }
  throw new Error(
    `Unsupported config file extension for ${input.configPath}. Expected .toml or .ts.`,
  );
}

async function loadProjectTsConfig(input: {
  configPath: string;
  baseConfig: unknown;
  options: LoadConfigOptions;
}): Promise<{
  mergedConfig: unknown;
  configPath: string;
  configHash?: string;
  configTrustStatus: ConfigTrustStatus;
  source: LoadedConfigSource;
  warnings: string[];
}> {
  const warnings = [
    'kyoso.config.ts is deprecated; migrate to kyoso.toml (see README "Configuration")',
  ];
  const source = await readFile(input.configPath, "utf8");
  const configHash = hashConfigSource(source);
  const trustStorePath =
    input.options.trustStorePath ??
    defaultTrustedConfigStorePath(input.options.env);
  const trusted = await isTrustedConfig(
    trustStorePath,
    input.configPath,
    configHash,
  );
  const trustDecision = await resolveTrustDecision({
    configPath: input.configPath,
    configHash,
    trusted,
    options: input.options,
  });

  if (trustDecision.execute) {
    const userConfig = await loadUserConfig(input.configPath, source);
    if (trustDecision.shouldPersist) {
      await trustConfig(trustStorePath, input.configPath, configHash);
    }
    return {
      mergedConfig: deepMerge(input.baseConfig, userConfig),
      configPath: input.configPath,
      configHash,
      configTrustStatus: trustDecision.status,
      source: { path: input.configPath, layer: "project_ts" },
      warnings,
    };
  }

  warnings.push(
    `untrusted config was not executed: ${input.configPath}; run \`kyoso doctor --trust-config\` or pass \`--trust-config\` once to trust it`,
  );
  return {
    mergedConfig: input.baseConfig,
    configPath: input.configPath,
    configHash,
    configTrustStatus: trustDecision.status,
    source: { path: input.configPath, layer: "project_ts" },
    warnings,
  };
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
