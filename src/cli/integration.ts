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
import type { ManualMcpStatus } from "./setup.js";

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

export type CliDetection = {
  kyoso: CliAvailability;
  npx: boolean;
  bunx: boolean;
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
    npx: commandExists("npx", env, platform),
    bunx: commandExists("bunx", env, platform),
  };
}

export function determineNonPluginIntegration(options: {
  manualMcpStatus: ManualMcpStatus;
  hasSkill: boolean;
  cli: CliDetection;
}): NonPluginIntegration {
  const warnings = manualMcpWarnings(options.manualMcpStatus);
  if (options.manualMcpStatus === "unknown") {
    return { mode: "unknown", warnings };
  }
  if (options.manualMcpStatus === "enabled") {
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
    if (options.cli.npx || options.cli.bunx) {
      warnings.push(
        "Package-runner fallback may require network access and can drift between versions.",
      );
      return { mode: "skill-on-demand", warnings };
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

function manualMcpWarnings(status: ManualMcpStatus): string[] {
  if (status === "disabled") return ["Manual MCP registration is disabled."];
  if (status === "unknown") {
    return [
      "Manual MCP registration could not be safely classified from its configuration.",
    ];
  }
  return [];
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
