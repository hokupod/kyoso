import { access, readFile } from "node:fs/promises";
import { stderr, stdin } from "node:process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultConfig } from "./defaultConfig.js";
import { kyosoConfigSchema, type KyosoConfig } from "./schema.js";
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
  trustPrompt?: (config: {
    configPath: string;
    configHash: string;
  }) => Promise<boolean>;
};

export type LoadedConfig = {
  config: KyosoConfig;
  configPath?: string;
  configHash?: string;
  configTrustStatus: ConfigTrustStatus;
  warnings: string[];
};

export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];
  let userConfig: unknown = {};
  let configPath: string | undefined;
  let configHash: string | undefined;
  let configTrustStatus: ConfigTrustStatus = options.ignoreConfig
    ? "ignored"
    : "not_found";

  if (!options.ignoreConfig) {
    const candidate = resolve(cwd, options.configPath ?? "kyoso.config.ts");
    if (await exists(candidate)) {
      configPath = candidate;
      const source = await readFile(candidate, "utf8");
      configHash = hashConfigSource(source);
      const trustStorePath =
        options.trustStorePath ?? defaultTrustedConfigStorePath();
      const trusted = await isTrustedConfig(
        trustStorePath,
        candidate,
        configHash,
      );
      const trustDecision = await resolveTrustDecision({
        configPath: candidate,
        configHash,
        trusted,
        options,
      });

      configTrustStatus = trustDecision.status;
      if (trustDecision.execute) {
        userConfig = await loadUserConfig(candidate, source);
        if (trustDecision.shouldPersist) {
          await trustConfig(trustStorePath, candidate, configHash);
        }
      } else {
        warnings.push(
          `untrusted config was not executed: ${candidate}; run \`kyoso doctor --trust-config\` or pass \`--trust-config\` once to trust it`,
        );
      }
    }
  }

  const parsed = kyosoConfigSchema.parse(deepMerge(defaultConfig, userConfig));
  return {
    config: parsed,
    configPath,
    configHash,
    configTrustStatus,
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
