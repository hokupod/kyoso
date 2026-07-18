import {
  buildKyosoPackageCommand,
  isCompleteSemVer,
  KYOSO_EXECUTABLE_NAME,
  KYOSO_PACKAGE_NAME,
  type KyosoPackageCommand,
  type KyosoPackageRunner,
} from "./packageRunner.js";

export type ManualMcpInvocationKind =
  "current" | "legacy" | "custom" | "unknown";

export type ManualMcpInvocationInspection = {
  kind: ManualMcpInvocationKind;
  runner?: KyosoPackageRunner;
  packageSpec?: string;
  legacyArgs?: readonly string[];
  replacement?: KyosoPackageCommand;
  reason: string;
};

const GENERATED_MCP_ENV_VALUE_NAMES = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENROUTER_API_KEY",
]);

const GENERATED_MCP_ENV_VAR_NAMES = new Set([
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "CODEX_ACCESS_TOKEN",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

export function inspectManualMcpInvocation(
  value: unknown,
): ManualMcpInvocationInspection {
  if (!isRecord(value)) {
    return { kind: "unknown", reason: "MCP entry is not an object." };
  }
  if (typeof value.command !== "string" || value.command.length === 0) {
    return {
      kind: "unknown",
      reason: "MCP command is missing or is not a string.",
    };
  }
  if (!Array.isArray(value.args) || !value.args.every(isString)) {
    return {
      kind: "unknown",
      reason: "MCP args are missing or are not an array of strings.",
    };
  }
  const environment = inspectMcpEnvironment(value);

  if (value.command === "npx") {
    return applyEnvironmentSafety(inspectNpx(value.args), environment);
  }
  if (value.command === "bunx") {
    return applyEnvironmentSafety(inspectBunx(value.args), environment);
  }
  return {
    kind: "custom",
    reason: `MCP command ${JSON.stringify(value.command)} is not a Kyoso package runner.`,
  };
}

function inspectMcpEnvironment(
  value: Record<string, unknown>,
): ManualMcpInvocationInspection | undefined {
  if ("env" in value && !isGeneratedMcpEnvironment(value.env)) {
    return {
      kind: "custom",
      reason:
        "MCP environment is not limited to generated credential placeholders.",
    };
  }
  if (
    "env_vars" in value &&
    !isGeneratedMcpEnvironmentVariables(value.env_vars)
  ) {
    return {
      kind: "custom",
      reason:
        "MCP environment variable forwarding is not limited to generated credential names.",
    };
  }
  return undefined;
}

function applyEnvironmentSafety(
  invocation: ManualMcpInvocationInspection,
  environment: ManualMcpInvocationInspection | undefined,
): ManualMcpInvocationInspection {
  return environment ?? invocation;
}

function isGeneratedMcpEnvironment(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([name, placeholder]) =>
      GENERATED_MCP_ENV_VALUE_NAMES.has(name) && placeholder === `\${${name}}`,
  );
}

function isGeneratedMcpEnvironmentVariables(value: unknown): boolean {
  if (!Array.isArray(value) || !value.every(isString)) return false;
  return (
    new Set(value).size === value.length &&
    value.every((name) => GENERATED_MCP_ENV_VAR_NAMES.has(name))
  );
}

function inspectNpx(args: string[]): ManualMcpInvocationInspection {
  const current = parseNpxCurrent(args);
  if (current) {
    return {
      kind: "current",
      runner: "npx",
      packageSpec: current.packageSpec,
      reason: "npx explicitly selects the Kyoso executable from its package.",
    };
  }

  const legacy = parseNpxLegacy(args);
  if (legacy) return legacyInspection("npx", legacy, args);

  return {
    kind: "custom",
    runner: "npx",
    reason: "npx arguments do not exactly match a supported Kyoso invocation.",
  };
}

function inspectBunx(args: string[]): ManualMcpInvocationInspection {
  const current = parseBunxCurrent(args);
  if (current) {
    return {
      kind: "current",
      runner: "bunx",
      packageSpec: current.packageSpec,
      reason: "bunx explicitly selects the Kyoso executable from its package.",
    };
  }

  const legacy = parseBunxLegacy(args);
  if (legacy) return legacyInspection("bunx", legacy, args);

  return {
    kind: "custom",
    runner: "bunx",
    reason: "bunx arguments do not exactly match a supported Kyoso invocation.",
  };
}

function legacyInspection(
  runner: KyosoPackageRunner,
  packageSpec: string,
  legacyArgs: readonly string[],
): ManualMcpInvocationInspection {
  const version = versionFromKnownPackageSpec(packageSpec);
  if (version === undefined && packageSpec !== KYOSO_PACKAGE_NAME) {
    return {
      kind: "custom",
      runner,
      packageSpec,
      reason:
        "Kyoso package spec is a tag, range, or malformed pin and is preserved.",
    };
  }
  return {
    kind: "legacy",
    runner,
    packageSpec,
    legacyArgs: [...legacyArgs],
    replacement: buildKyosoPackageCommand({
      runner,
      ...(version === undefined ? {} : { version }),
      cliArgs: ["mcp"],
    }),
    reason:
      "Kyoso package runner relies on executable inference with a multi-bin package.",
  };
}

function parseNpxCurrent(args: string[]): { packageSpec: string } | undefined {
  if (
    args.length !== 4 ||
    args[0] !== "-y" ||
    args[2] !== KYOSO_EXECUTABLE_NAME ||
    args[3] !== "mcp"
  ) {
    return undefined;
  }
  const packageSpec = args[1]?.startsWith("--package=")
    ? args[1].slice("--package=".length)
    : undefined;
  return packageSpec && isKnownPackageSpec(packageSpec)
    ? { packageSpec }
    : undefined;
}

function parseBunxCurrent(args: string[]): { packageSpec: string } | undefined {
  if (
    args.length !== 4 ||
    args[0] !== "--package" ||
    args[2] !== KYOSO_EXECUTABLE_NAME ||
    args[3] !== "mcp"
  ) {
    return undefined;
  }
  const packageSpec = args[1];
  return packageSpec && isKnownPackageSpec(packageSpec)
    ? { packageSpec }
    : undefined;
}

function parseNpxLegacy(args: string[]): string | undefined {
  const packageIndex = args[0] === "-y" ? 1 : 0;
  if (args.length !== packageIndex + 2 || args[packageIndex + 1] !== "mcp") {
    return undefined;
  }
  const packageSpec = args[packageIndex];
  return packageSpec && packageSpec.startsWith(KYOSO_PACKAGE_NAME)
    ? packageSpec
    : undefined;
}

function parseBunxLegacy(args: string[]): string | undefined {
  if (args.length !== 2 || args[1] !== "mcp") return undefined;
  const packageSpec = args[0];
  return packageSpec && packageSpec.startsWith(KYOSO_PACKAGE_NAME)
    ? packageSpec
    : undefined;
}

function isKnownPackageSpec(packageSpec: string): boolean {
  return (
    packageSpec === KYOSO_PACKAGE_NAME ||
    versionFromKnownPackageSpec(packageSpec) !== undefined
  );
}

function versionFromKnownPackageSpec(packageSpec: string): string | undefined {
  const prefix = `${KYOSO_PACKAGE_NAME}@`;
  if (!packageSpec.startsWith(prefix)) return undefined;
  const version = packageSpec.slice(prefix.length);
  return isCompleteSemVer(version) ? version : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
