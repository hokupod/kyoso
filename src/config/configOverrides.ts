import {
  CODEX_DEFAULT_PROVIDER,
  CODEX_OPENROUTER_PROVIDER,
  kyosoConfigSchema,
  type KyosoConfig,
} from "./schema.js";
import { isAllowedConfigOverridePath } from "./projectScope.js";

type ParsedConfigOverride = {
  assignment: string;
  path: string[];
  value: string;
};

const NUMBER_VALUE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const UNSET_NUMBER_OVERRIDE_PATHS = new Set([
  "agents.codex.openRouter.streamIdleTimeoutMs",
  "agents.codex.openRouter.streamMaxRetries",
  "agents.codex.openRouter.requestMaxRetries",
]);

export function applyConfigOverrides(
  config: KyosoConfig,
  assignments: string[],
): KyosoConfig {
  if (assignments.length === 0) return config;

  const overrides = assignments.map(parseConfigOverride);
  const baseConfig = config as unknown as Record<string, unknown>;
  const overridden = structuredClone(config) as Record<string, unknown>;
  for (const override of overrides) {
    writePath(
      overridden,
      override.path,
      parseConfigOverrideValue(
        override.value,
        readPath(baseConfig, override.path),
        override.path,
      ),
    );
  }
  clearInheritedOpenRouterConfigForProviderReset(
    baseConfig,
    overridden,
    overrides,
  );
  assertOpenRouterProviderOverrideIncludesModel(
    baseConfig,
    overridden,
    overrides,
  );

  const parsed = kyosoConfigSchema.safeParse(overridden);
  if (parsed.success) return parsed.data;

  const issue = parsed.error.issues[0];
  const issuePath = issue?.path.map(String).join(".") ?? "config";
  const assignment =
    findAssignmentForPath(overrides, issuePath) ?? assignments.at(-1) ?? "";
  throw new Error(
    `Invalid --set value ${JSON.stringify(assignment)}: ${issuePath}: ${issue?.message ?? "config validation failed"}.`,
  );
}

function assertOpenRouterProviderOverrideIncludesModel(
  baseConfig: Record<string, unknown>,
  overridden: Record<string, unknown>,
  overrides: ParsedConfigOverride[],
): void {
  const providerPath = ["agents", "codex", "provider"];
  const modelPath = ["agents", "codex", "model"];
  const selectsOpenRouter =
    readPath(overridden, providerPath) === CODEX_OPENROUTER_PROVIDER;
  const alreadySelected =
    readPath(baseConfig, providerPath) === CODEX_OPENROUTER_PROVIDER;
  const suppliesModel = overrides.some(
    (override) => override.path.join(".") === modelPath.join("."),
  );
  if (!selectsOpenRouter || alreadySelected || suppliesModel) return;

  const assignment =
    findAssignmentForPath(overrides, providerPath.join(".")) ??
    "agents.codex.provider=openrouter";
  throw new Error(
    `Invalid --set value ${JSON.stringify(assignment)}: selecting agents.codex.provider=openrouter requires agents.codex.model in the same --set invocation.`,
  );
}

function clearInheritedOpenRouterConfigForProviderReset(
  baseConfig: Record<string, unknown>,
  overridden: Record<string, unknown>,
  overrides: ParsedConfigOverride[],
): void {
  const providerPath = ["agents", "codex", "provider"];
  const modelPath = ["agents", "codex", "model"];
  const openRouterPath = ["agents", "codex", "openRouter"];
  const selectsDefaultProvider = overrides.some(
    (override) =>
      override.path.join(".") === providerPath.join(".") &&
      override.value === CODEX_DEFAULT_PROVIDER,
  );
  const suppliesModel = overrides.some(
    (override) => override.path.join(".") === modelPath.join("."),
  );
  const suppliesOpenRouterPolicy = overrides.some((override) =>
    override.path.join(".").startsWith(`${openRouterPath.join(".")}.`),
  );
  if (
    !selectsDefaultProvider ||
    readPath(baseConfig, providerPath) !== CODEX_OPENROUTER_PROVIDER ||
    readPath(overridden, providerPath) !== CODEX_DEFAULT_PROVIDER
  ) {
    return;
  }

  const codex = readPath(overridden, ["agents", "codex"]);
  if (!isRecord(codex)) return;
  if (!suppliesModel) delete codex.model;
  if (!suppliesOpenRouterPolicy) delete codex.openRouter;
}

function findAssignmentForPath(
  overrides: ParsedConfigOverride[],
  path: string,
): string | undefined {
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const override = overrides[index];
    if (override?.path.join(".") === path) return override.assignment;
  }
  return undefined;
}

function parseConfigOverride(assignment: string): ParsedConfigOverride {
  const separator = assignment.indexOf("=");
  if (separator <= 0) {
    throw new Error(
      `Invalid --set value ${JSON.stringify(assignment)}. Expected key=value.`,
    );
  }

  const key = assignment.slice(0, separator);
  const path = key.split(".");
  if (!isAllowedConfigOverridePath(path)) {
    throw new Error(`Unknown --set key ${JSON.stringify(key)}.`);
  }

  return {
    assignment,
    path,
    value: assignment.slice(separator + 1),
  };
}

function parseConfigOverrideValue(
  value: string,
  currentValue: unknown,
  path: string[],
): string | number | boolean {
  if (typeof currentValue === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }
  if (
    (typeof currentValue === "number" ||
      (currentValue === undefined &&
        UNSET_NUMBER_OVERRIDE_PATHS.has(path.join(".")))) &&
    NUMBER_VALUE.test(value)
  ) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

function readPath(target: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = target;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function writePath(
  target: Record<string, unknown>,
  path: string[],
  value: string | number | boolean,
): void {
  let current = target;
  for (const key of path.slice(0, -1)) {
    const child = current[key];
    if (!isRecord(child)) {
      throw new Error(
        `Cannot apply --set key ${JSON.stringify(path.join("."))}.`,
      );
    }
    current = child;
  }
  const leaf = path.at(-1);
  if (leaf) current[leaf] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
