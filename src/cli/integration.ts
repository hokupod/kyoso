import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import type { ManualMcpRegistration, ManualMcpStatus } from "./setup.js";
import { formatKyosoPackageCommand } from "./packageRunner.js";

export type IntegrationMode =
  | "manual-mcp"
  | "cli-skill"
  | "skill-on-demand"
  | "mcp-only"
  | "cli-only"
  | "missing"
  | "unknown";

export type InstalledCli = {
  kind: "installed";
  version: string;
  scope: "project" | "global";
};

export type CliAvailability =
  InstalledCli | { kind: "missing" | "transient" | "unknown" };

export type RunnerAvailability = "available" | "missing" | "present-unverified";

export type CliDetection = {
  kyoso: CliAvailability;
  npx: RunnerAvailability;
  bunx: RunnerAvailability;
};

export type NonPluginIntegration = {
  mode: IntegrationMode;
  warnings: string[];
};

export function detectCli(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): CliDetection {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    kyoso: detectInstalledKyoso(options.cwd, env, platform),
    npx: commandExists("npx", env, platform) ? "available" : "missing",
    bunx: commandExists("bunx", env, platform)
      ? "present-unverified"
      : "missing",
  };
}

export function determineNonPluginIntegration(options: {
  manualMcpStatus: ManualMcpStatus;
  manualMcpRegistrations: readonly ManualMcpRegistration[];
  hasSkill: boolean;
  cli: CliDetection;
}): NonPluginIntegration {
  const warnings = manualMcpWarnings(
    options.manualMcpStatus,
    options.manualMcpRegistrations,
    options.cli,
  );
  if (options.manualMcpStatus === "unknown") {
    return { mode: "unknown", warnings };
  }
  if (options.manualMcpStatus === "enabled") {
    if (!hasCurrentManualMcp(options.manualMcpRegistrations, options.cli)) {
      return { mode: "unknown", warnings };
    }
    return {
      mode: options.hasSkill ? "manual-mcp" : "mcp-only",
      warnings,
    };
  }

  const cliWarnings = cliIdentityWarnings(options.cli.kyoso);
  warnings.push(...cliWarnings);
  if (options.hasSkill) {
    if (options.cli.kyoso.kind === "installed") {
      return { mode: "cli-skill", warnings };
    }
    if (options.cli.npx === "available") {
      warnings.push(
        "Package-runner fallback may require network access and can drift between versions.",
      );
      return { mode: "skill-on-demand", warnings };
    }
    if (options.cli.bunx === "present-unverified") {
      warnings.push(
        "bunx is present but unverified; run setup --runner bunx to verify Bun 1.3.14 or newer, or use npx/PATH installation.",
      );
    }
    if (options.cli.kyoso.kind === "unknown") {
      return { mode: "unknown", warnings };
    }
    warnings.push(
      "The Skill is installed, but no supported Kyoso CLI execution path was found.",
    );
    return { mode: "missing", warnings };
  }

  if (options.cli.kyoso.kind === "installed") {
    return { mode: "cli-only", warnings };
  }
  if (options.cli.kyoso.kind === "unknown") {
    return { mode: "unknown", warnings };
  }
  return { mode: "missing", warnings };
}

export function formatRunnerAvailability(runner: RunnerAvailability): string {
  if (runner === "available") return "available";
  if (runner === "present-unverified") return "present-unverified";
  return "missing";
}

export function formatCliAvailability(cli: CliAvailability): string {
  if (cli.kind === "installed") {
    return `installed @kyo-so/cli ${cli.version} (${cli.scope})`;
  }
  if (cli.kind === "transient") {
    return "temporary runner (not treated as an installed CLI)";
  }
  if (cli.kind === "unknown") {
    return "unrecognized PATH entry (not treated as an installed CLI)";
  }
  return "missing";
}

function detectInstalledKyoso(
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): CliAvailability {
  const executable = resolveCommand("kyoso", env, platform);
  if (!executable) return { kind: "missing" };

  let realExecutable: string;
  try {
    realExecutable = realpathSync(executable);
  } catch {
    return { kind: "unknown" };
  }
  if (isTransientPath(realExecutable, cwd)) return { kind: "transient" };

  const packageInfo = findKyosoPackage(realExecutable);
  if (!packageInfo) return { kind: "unknown" };
  return {
    kind: "installed",
    version: packageInfo.version,
    scope: isWithin(packageInfo.directory, realPathOrResolved(cwd))
      ? "project"
      : "global",
  };
}

function findKyosoPackage(
  executable: string,
): { directory: string; version: string } | undefined {
  let directory = dirname(executable);
  for (;;) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
        if (
          isRecord(parsed) &&
          parsed.name === "@kyo-so/cli" &&
          typeof parsed.version === "string" &&
          parsed.version.trim().length > 0
        ) {
          return { directory, version: parsed.version };
        }
      } catch {
        // Keep looking for the owning package above malformed or unreadable
        // package metadata in an intermediate directory.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function isTransientPath(path: string, cwd: string): boolean {
  if (path.split(/[\\/]/).includes("_npx")) return true;
  const temporaryRoot = realPathOrResolved(tmpdir());
  return (
    isWithin(path, temporaryRoot) && !isWithin(path, realPathOrResolved(cwd))
  );
}

function realPathOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function manualMcpWarnings(
  status: ManualMcpStatus,
  registrations: readonly ManualMcpRegistration[],
  cli: CliDetection,
): string[] {
  if (status === "missing") return [];
  if (status === "disabled") return ["Manual MCP registration is disabled."];
  if (status === "unknown") {
    return [
      "Manual MCP registration could not be safely classified from its configuration.",
    ];
  }
  if (registrations.length === 0) {
    return [
      "Manual MCP registration is enabled but no exact registration could be verified.",
    ];
  }
  if (registrations.length !== 1) {
    return [
      "Multiple manual MCP registrations were found; their effective precedence is not inferred.",
    ];
  }
  const registration = registrations[0];
  const invocation = registration?.invocation;
  if (invocation?.kind === "legacy") {
    return [legacyManualMcpRepairWarning(registration, cli)];
  }
  if (invocation?.kind === "custom") {
    return [
      "Manual MCP registration is custom/unverified and was not treated as a ready Kyoso registration.",
    ];
  }
  if (invocation?.kind === "unknown") {
    return [
      "Manual MCP invocation could not be safely classified and was not treated as a ready Kyoso registration.",
    ];
  }
  if (invocation?.runner === "npx" && cli.npx !== "available") {
    return [
      "Manual MCP registration uses npx, but npx is not available on PATH.",
    ];
  }
  if (invocation?.runner === "bunx") {
    if (cli.bunx === "missing") {
      return [
        "Manual MCP registration uses bunx, but bunx is not available on PATH.",
      ];
    }
    return [
      "Manual MCP registration uses bunx, but normal doctor does not verify the required Bun capability. Run setup --runner bunx before treating it as ready.",
    ];
  }
  return [];
}

function legacyManualMcpRepairWarning(
  registration: ManualMcpRegistration | undefined,
  cli: CliDetection,
): string {
  if (!registration) {
    return "Manual MCP registration uses legacy package-runner arguments and requires repair.";
  }
  const client =
    registration.scope === "codex-global"
      ? "codex"
      : registration.scope === "claude-project"
        ? "claude-code"
        : undefined;
  if (!client) {
    return `Manual MCP registration at ${registration.path} uses legacy package-runner arguments. Its ${registration.scope} scope is not automatically migrated; update it manually.`;
  }
  const command =
    cli.kyoso.kind === "installed"
      ? `kyoso setup ${client} --write --force`
      : cli.npx === "available"
        ? formatKyosoPackageCommand({
            runner: "npx",
            cliArgs: ["setup", client, "--write", "--force"],
          })
        : undefined;
  if (!command) {
    return `Manual MCP registration at ${registration.path} uses legacy package-runner arguments, but no executable Kyoso repair path is available. Update it manually.`;
  }
  return `Manual MCP registration uses legacy package-runner arguments. Run \`${command}\` to migrate this exact registration.`;
}

function hasCurrentManualMcp(
  registrations: readonly ManualMcpRegistration[],
  cli: CliDetection,
): boolean {
  const registration = registrations[0];
  return (
    registrations.length === 1 &&
    registration?.invocation.kind === "current" &&
    registration.invocation.runner === "npx" &&
    cli.npx === "available"
  );
}

function cliIdentityWarnings(cli: CliAvailability): string[] {
  if (cli.kind === "transient") {
    return [
      "A temporary Kyoso runner was found on PATH and is not treated as an installed CLI.",
    ];
  }
  if (cli.kind === "unknown") {
    return [
      "A PATH entry named kyoso does not identify itself as @kyo-so/cli and is not treated as an installed CLI.",
    ];
  }
  return [];
}

function commandExists(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  return resolveCommand(command, env, platform) !== undefined;
}

function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  for (const path of env.PATH?.split(delimiter) ?? []) {
    if (path.length === 0) continue;
    for (const name of commandNames(command, env, platform)) {
      const candidate = join(path, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue with the next candidate.
      }
    }
  }
  return undefined;
}

function commandNames(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  if (platform !== "win32" || extname(command).length > 0) return [command];

  const names = [command];
  const seen = new Set([command.toLowerCase()]);
  for (const extension of env.PATHEXT?.split(";") ?? []) {
    const normalized = extension.trim();
    if (!normalized.startsWith(".") || /[\\/]/.test(normalized)) continue;
    const candidate = `${command}${normalized}`;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(candidate);
  }
  return names;
}

function isWithin(path: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(path));
  return (
    relativePath === "" ||
    (!relativePath.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
