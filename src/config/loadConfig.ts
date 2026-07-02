import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultConfig } from "./defaultConfig.js";
import { kyosoConfigSchema, type KyosoConfig } from "./schema.js";
import { loadConfigModule } from "./tsConfigLoader.js";

export type LoadConfigOptions = {
  cwd?: string;
  configPath?: string;
  ignoreConfig?: boolean;
};

export type LoadedConfig = {
  config: KyosoConfig;
  configPath?: string;
  configHash?: string;
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

  if (!options.ignoreConfig) {
    const candidate = resolve(cwd, options.configPath ?? "kyoso.config.ts");
    if (await exists(candidate)) {
      configPath = candidate;
      const source = await readFile(candidate, "utf8");
      configHash = createHash("sha256").update(source).digest("hex");
      try {
        const loaded = await loadConfigModule(candidate, source);
        userConfig = loaded.default ?? loaded.config ?? {};
      } catch (error) {
        throw new Error(
          `Config load failed for ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const parsed = kyosoConfigSchema.parse(deepMerge(defaultConfig, userConfig));
  return { config: parsed, configPath, configHash, warnings };
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
