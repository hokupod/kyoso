import { spawnSync } from "node:child_process";
import {
  MINIMUM_SUPPORTED_CODEX_VERSION,
  PLUGIN_LIST_JSON_SCHEMA,
  PLUGIN_RUNTIME_EXPECTED_CONTRACT,
} from "./pluginRuntimeContract.js";

export const CODEX_PLUGIN_INSPECTION_TIMEOUT_MS = 5_000;

const MAX_CODEX_INSPECTION_TIMEOUT_MS = 10_000;
const CODEX_INSPECTION_MAX_BUFFER_BYTES = 1024 * 1024;

export type CodexInspectionOperation = "version" | "plugin_list" | "mcp_list";

export type CodexInspectionFailureReason =
  | "unavailable"
  | "timeout"
  | "command_failed"
  | "invalid_output"
  | "unknown_schema"
  | "unsupported_version";

export type CodexInspectionFailure = {
  operation: CodexInspectionOperation;
  reason: CodexInspectionFailureReason;
};

export type CodexCommand = {
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
};

export type CodexCommandResult =
  | { kind: "completed"; exitCode: number; stdout: string }
  | { kind: "unavailable" }
  | { kind: "timeout" }
  | { kind: "failed" };

export type CodexCommandRunner = (command: CodexCommand) => CodexCommandResult;

export type CodexPluginInspectionOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runCodex?: CodexCommandRunner;
};

export type CodexPluginState = "enabled" | "disabled" | "not_installed";

export type CodexPluginInspection =
  | {
      status: "supported";
      codexVersion: string;
      plugin: {
        pluginId: typeof PLUGIN_RUNTIME_EXPECTED_CONTRACT.marketplace.pluginId;
        installed: boolean;
        enabled: boolean;
        state: CodexPluginState;
      };
    }
  | { status: "unsupported"; failure: CodexInspectionFailure };

export type CodexMcpStatus = "enabled" | "disabled" | "missing" | "unknown";

export type CodexMcpListInspection =
  | { status: "supported"; kyoso: CodexMcpStatus }
  | { status: "unsupported"; failure: CodexInspectionFailure };

/**
 * Inspects only the stable Codex Plugin interface. It intentionally does not
 * read Plugin cache files or configuration; Doctor composes this with the
 * separately resolved manual-MCP and Plugin-override state.
 */
export function inspectCodexPlugin(
  options: CodexPluginInspectionOptions,
): CodexPluginInspection {
  const input = normalizeOptions(options);
  const versionResult = input.runCodex(commandFor(input, ["--version"]));
  if (versionResult.kind !== "completed") {
    return unsupported("version", failureReason(versionResult));
  }

  const codexVersion = parseCodexVersion(versionResult.stdout);
  if (!codexVersion) return unsupported("version", "invalid_output");
  if (compareSemver(codexVersion, MINIMUM_SUPPORTED_CODEX_VERSION) < 0) {
    return unsupported("version", "unsupported_version");
  }

  const pluginListResult = input.runCodex(
    commandFor(input, ["plugin", "list", "--json"]),
  );
  if (pluginListResult.kind !== "completed") {
    return unsupported("plugin_list", failureReason(pluginListResult));
  }

  const parsed = parseJson(pluginListResult.stdout);
  if (parsed === undefined) return unsupported("plugin_list", "invalid_output");

  const plugin = parsePluginList(parsed);
  if (!plugin) return unsupported("plugin_list", "unknown_schema");

  return { status: "supported", codexVersion, plugin };
}

/**
 * Reads the effective MCP list lazily. Doctor must call this only after it has
 * confirmed that no top-level manual `mcp_servers.kyoso` entry exists.
 */
export function inspectCodexMcpList(
  options: CodexPluginInspectionOptions,
): CodexMcpListInspection {
  const input = normalizeOptions(options);
  const result = input.runCodex(commandFor(input, ["mcp", "list", "--json"]));
  if (result.kind !== "completed") {
    return unsupported("mcp_list", failureReason(result));
  }

  const parsed = parseJson(result.stdout);
  if (parsed === undefined) return unsupported("mcp_list", "invalid_output");

  const kyoso = parseMcpList(parsed);
  if (!kyoso) return unsupported("mcp_list", "unknown_schema");
  return { status: "supported", kyoso };
}

/**
 * Returns a fixed, display-safe diagnostic. Never append command stderr or
 * filesystem paths to this message.
 */
export function formatCodexInspectionFailure(
  failure: CodexInspectionFailure,
): string {
  const operation = {
    version: "Codex version",
    plugin_list: "Codex Plugin list",
    mcp_list: "Codex MCP list",
  }[failure.operation];
  const reason = {
    unavailable: "is unavailable",
    timeout: "timed out",
    command_failed: "could not be inspected",
    invalid_output: "returned unsupported output",
    unknown_schema: "returned an unsupported schema",
    unsupported_version: "is below the supported version",
  }[failure.reason];
  return `${operation} ${reason}.`;
}

type NormalizedOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  runCodex: CodexCommandRunner;
};

type ParsedPlugin = Extract<
  CodexPluginInspection,
  { status: "supported" }
>["plugin"];

type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function normalizeOptions(
  options: CodexPluginInspectionOptions,
): NormalizedOptions {
  return {
    cwd: options.cwd,
    env: options.env ?? process.env,
    timeoutMs: boundedTimeout(options.timeoutMs),
    runCodex: options.runCodex ?? runCodex,
  };
}

function boundedTimeout(timeoutMs: number | undefined): number {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return CODEX_PLUGIN_INSPECTION_TIMEOUT_MS;
  }
  return Math.min(timeoutMs, MAX_CODEX_INSPECTION_TIMEOUT_MS);
}

function commandFor(
  options: NormalizedOptions,
  args: readonly string[],
): CodexCommand {
  return {
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  };
}

function runCodex(command: CodexCommand): CodexCommandResult {
  const result = spawnSync("codex", command.args, {
    cwd: command.cwd,
    env: command.env,
    encoding: "utf8",
    timeout: command.timeoutMs,
    maxBuffer: CODEX_INSPECTION_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
  const errorCode = commandErrorCode(result.error);
  if (errorCode === "ENOENT") return { kind: "unavailable" };
  if (errorCode === "ETIMEDOUT") return { kind: "timeout" };
  if (result.error || result.status === null || result.status !== 0) {
    return { kind: "failed" };
  }
  return {
    kind: "completed",
    exitCode: result.status,
    stdout: String(result.stdout ?? ""),
  };
}

function commandErrorCode(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string"
  ) {
    return undefined;
  }
  return error.code;
}

function failureReason(
  result: Exclude<CodexCommandResult, { kind: "completed" }>,
): CodexInspectionFailureReason {
  if (result.kind === "unavailable") return "unavailable";
  if (result.kind === "timeout") return "timeout";
  return "command_failed";
}

function unsupported(
  operation: CodexInspectionOperation,
  reason: CodexInspectionFailureReason,
): { status: "unsupported"; failure: CodexInspectionFailure } {
  return { status: "unsupported", failure: { operation, reason } };
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parsePluginList(value: unknown): ParsedPlugin | undefined {
  if (!isRecord(value)) return undefined;
  const allowedKeys: ReadonlySet<string> = new Set(
    PLUGIN_LIST_JSON_SCHEMA.collections,
  );
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    return undefined;
  }

  const installed = parsePluginEntries(value.installed);
  const available = parsePluginEntries(value.available);
  if (!installed || !available) return undefined;

  const matches = [...installed, ...available].filter(
    (entry) =>
      entry.pluginId === PLUGIN_RUNTIME_EXPECTED_CONTRACT.marketplace.pluginId,
  );
  if (matches.length > 1) return undefined;
  if (matches.length === 0) {
    return pluginState(false, false);
  }

  const entry = matches[0]!;
  if (!entry.installed && entry.enabled) return undefined;
  return pluginState(entry.installed, entry.enabled);
}

function parsePluginEntries(value: unknown): PluginListEntry[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;

  const entries: PluginListEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    if (
      typeof item.pluginId !== "string" ||
      typeof item.installed !== "boolean" ||
      typeof item.enabled !== "boolean"
    ) {
      return undefined;
    }
    entries.push({
      pluginId: item.pluginId,
      installed: item.installed,
      enabled: item.enabled,
    });
  }
  return entries;
}

function pluginState(installed: boolean, enabled: boolean): ParsedPlugin {
  return {
    pluginId: PLUGIN_RUNTIME_EXPECTED_CONTRACT.marketplace.pluginId,
    installed,
    enabled,
    state: installed ? (enabled ? "enabled" : "disabled") : "not_installed",
  };
}

function parseMcpList(value: unknown): CodexMcpStatus | undefined {
  if (!Array.isArray(value)) return undefined;

  const matches: boolean[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") return "unknown";
    if (item.name !== "kyoso") continue;
    if (typeof item.enabled !== "boolean") return "unknown";
    matches.push(item.enabled);
  }
  if (matches.length === 0) return "missing";
  if (matches.length > 1) return "unknown";
  return matches[0] ? "enabled" : "disabled";
}

function parseCodexVersion(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^codex-cli\s+(\S+)\s*$/.exec(line.trim());
    const version = match?.[1];
    if (version && parseSemver(version)) return version;
  }
  return undefined;
}

function compareSemver(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) return 0;

  for (const key of ["major", "minor", "patch"] as const) {
    if (parsedLeft[key] !== parsedRight[key]) {
      return parsedLeft[key] < parsedRight[key] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      value,
    );
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return undefined;
  }
  return {
    major,
    minor,
    patch,
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PluginListEntry = {
  pluginId: string;
  installed: boolean;
  enabled: boolean;
};
