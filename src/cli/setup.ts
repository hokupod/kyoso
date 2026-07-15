import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { ensureManagedSkill } from "./skillInstall.js";

export type SetupClient = "codex" | "claude-code";
export type SetupRunner = "npx" | "bunx";
export type SetupScope = "project" | "global";
export type ManualMcpStatus = "enabled" | "disabled" | "missing" | "unknown";

export type SetupDetection = {
  mcp: boolean;
  skill: boolean;
  manualMcpStatus: ManualMcpStatus;
  mcpPaths: string[];
  skillPaths: string[];
};

export type CodexPluginMcpOverride = {
  status: ManualMcpStatus;
  path: string;
};

export type SetupOptions = {
  cwd: string;
  client?: string;
  write: boolean;
  global: boolean;
  withOpenRouter?: boolean;
  runner?: string;
  command?: string;
  skillOnly?: boolean;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
};

type McpCommand = {
  command: string;
  args: string[];
};

type StepResultBase = {
  title: string;
  status: "dry-run" | "created" | "updated" | "skipped" | "conflict";
  path?: string;
  detail?: string;
};

type McpStepResult = StepResultBase & {
  kind: "mcp";
  registration: "generated" | "preserved";
};

type NonMcpStepResult = StepResultBase & {
  kind: "skill" | "advice";
};

type StepResult = McpStepResult | NonMcpStepResult;

type SetupContext = {
  cwd: string;
  home: string;
  codexHome: string;
  env: NodeJS.ProcessEnv;
  write: boolean;
  scope: SetupScope;
  skillOnly: boolean;
  force: boolean;
  withOpenRouter: boolean;
  mcpCommand: McpCommand;
  sourceSkillDir: string;
};

export async function runSetup(options: SetupOptions): Promise<string> {
  const client = parseClient(options.client);
  validateSkillOnlyOptions(options, client);
  const runner = parseRunner(options.runner);
  const command = options.command
    ? parseCommandSpec(options.command)
    : commandForRunner(runner);
  const env = options.env ?? process.env;
  const home = resolveUserHome(env);
  const context: SetupContext = {
    cwd: options.cwd,
    home,
    codexHome: dirname(resolveCodexConfigPath(env, options.cwd)),
    env,
    write: options.write,
    scope: options.global ? "global" : "project",
    skillOnly: options.skillOnly ?? false,
    force: options.force ?? false,
    withOpenRouter: options.withOpenRouter ?? false,
    mcpCommand: command,
    sourceSkillDir: resolveBundledSkillDir(),
  };

  if (!client) return renderSetupOverview(context);
  if (client === "codex") {
    return renderResults(context, await setupCodex(context));
  }
  return renderResults(context, await setupClaudeCode(context));
}

export function commandForRunner(runner: SetupRunner): McpCommand {
  if (runner === "bunx") {
    return { command: "bunx", args: ["@kyo-so/cli", "mcp"] };
  }
  return { command: "npx", args: ["-y", "@kyo-so/cli", "mcp"] };
}

export function buildCodexMcpToml(
  command: McpCommand,
  withOpenRouter = false,
): string {
  const envVars = [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "CODEX_ACCESS_TOKEN",
    ...(withOpenRouter ? ["OPENROUTER_API_KEY"] : []),
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  return [
    "[mcp_servers.kyoso]",
    `command = ${JSON.stringify(command.command)}`,
    `args = ${JSON.stringify(command.args)}`,
    `env_vars = [${envVars.map((value) => JSON.stringify(value)).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 360",
    "enabled = true",
    "",
  ].join("\n");
}

export function buildClaudeMcpEntry(
  command: McpCommand,
  withOpenRouter = false,
): Record<string, unknown> {
  const env: Record<string, string> = {
    OPENAI_API_KEY: "${OPENAI_API_KEY}",
    ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
    CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}",
  };
  if (withOpenRouter) {
    env.OPENROUTER_API_KEY = "${OPENROUTER_API_KEY}";
  }
  return {
    command: command.command,
    args: command.args,
    env,
  };
}

export function skillDestination(
  client: SetupClient,
  scope: SetupScope,
  cwd: string,
  home: string,
): string {
  if (client === "codex") {
    const root = scope === "global" ? home : cwd;
    return join(root, ".agents", "skills", "kyoso-review");
  }
  const root = scope === "global" ? home : cwd;
  return join(root, ".claude", "skills", "kyoso-review");
}

export function resolveUserHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME ? resolve(env.HOME) : homedir();
}

export function resolveCodexConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const codexHome = env.CODEX_HOME
    ? resolve(cwd, env.CODEX_HOME)
    : join(resolveUserHome(env), ".codex");
  return join(codexHome, "config.toml");
}

export function resolveCodexUserSkillPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveUserHome(env), ".agents", "skills", "kyoso-review");
}

export function detectCodexPluginMcpOverride(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): CodexPluginMcpOverride {
  const env = options.env ?? process.env;
  const path = resolveCodexConfigPath(env, options.cwd);
  if (!existsSync(path)) return { status: "missing", path };

  try {
    const parsed = parse(readTextSync(path));
    if (
      hasUnprobedProjectIntegrationOverride(
        parsed,
        options.cwd,
        resolveUserHome(env),
      )
    ) {
      return { status: "unknown", path };
    }
    return {
      status: nestedMcpEntryStatus(parsed, [
        "plugins",
        "kyoso@kyoso",
        "mcp_servers",
        "kyoso",
      ]),
      path,
    };
  } catch {
    return { status: "unknown", path };
  }
}

export function detectSetup(options: {
  cwd: string;
  home?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
}): Record<SetupClient, SetupDetection> {
  const env = options.env ?? process.env;
  const home = options.home ? resolve(options.home) : resolveUserHome(env);
  const codexConfigPath = options.codexHome
    ? join(resolve(options.codexHome), "config.toml")
    : options.home
      ? join(home, ".codex", "config.toml")
      : resolveCodexConfigPath(env, options.cwd);
  const codexMcp = detectCodexMcp(codexConfigPath, options.cwd, home);
  const claudeMcp = mergeMcpDetections([
    detectClaudeMcp(join(options.cwd, ".mcp.json"), options.cwd, home),
    detectClaudeMcp(join(home, ".claude.json"), options.cwd, home),
  ]);
  const codexSkillPaths = existingSkillPaths([
    join(options.cwd, ".agents", "skills", "kyoso-review"),
    join(home, ".agents", "skills", "kyoso-review"),
  ]);
  const claudeSkillPaths = existingSkillPaths([
    join(options.cwd, ".claude", "skills", "kyoso-review"),
    join(home, ".claude", "skills", "kyoso-review"),
  ]);

  return {
    codex: {
      mcp: codexMcp.status === "enabled",
      skill: codexSkillPaths.length > 0,
      manualMcpStatus: codexMcp.status,
      mcpPaths: codexMcp.paths,
      skillPaths: codexSkillPaths,
    },
    "claude-code": {
      mcp: claudeMcp.status === "enabled",
      skill: claudeSkillPaths.length > 0,
      manualMcpStatus: claudeMcp.status,
      mcpPaths: claudeMcp.paths,
      skillPaths: claudeSkillPaths,
    },
  };
}

async function setupCodex(context: SetupContext): Promise<StepResult[]> {
  if (context.skillOnly) {
    return [
      await ensureSkill(context, "codex", "Codex skill"),
      ...singleAgentAdvice(context, "codex"),
    ];
  }
  return [
    await ensureCodexMcp(context),
    await ensureSkill(context, "codex", "Codex skill"),
    ...singleAgentAdvice(context, "codex"),
  ];
}

async function setupClaudeCode(context: SetupContext): Promise<StepResult[]> {
  if (context.skillOnly) {
    return [
      await ensureSkill(context, "claude-code", "Claude Code skill"),
      ...singleAgentAdvice(context, "claude-code"),
    ];
  }
  return [
    await ensureClaudeMcp(context),
    await ensureSkill(context, "claude-code", "Claude Code skill"),
    ...singleAgentAdvice(context, "claude-code"),
  ];
}

async function ensureCodexMcp(context: SetupContext): Promise<StepResult> {
  const configPath = join(context.codexHome, "config.toml");
  const snippet = buildCodexMcpToml(context.mcpCommand, context.withOpenRouter);
  const current = await readOptionalFile(configPath);
  if (hasCodexMcpContent(current)) {
    return {
      kind: "mcp",
      registration: "preserved",
      title: "Codex MCP",
      status: "skipped",
      path: configPath,
      detail:
        codexMcpStatusFromContent(current) === "disabled"
          ? disabledCodexMcpDetail(configPath)
          : "existing [mcp_servers.kyoso] kept",
    };
  }
  const detail = diffForAppend(configPath, snippet);
  if (!context.write) {
    return {
      kind: "mcp",
      registration: "generated",
      title: "Codex MCP",
      status: "dry-run",
      path: configPath,
      detail,
    };
  }
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n\n" : "";
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${current}${separator}${snippet}`, "utf8");
  return {
    kind: "mcp",
    registration: "generated",
    title: "Codex MCP",
    status: current.length > 0 ? "updated" : "created",
    path: configPath,
    detail,
  };
}

async function ensureClaudeMcp(context: SetupContext): Promise<StepResult> {
  if (context.scope === "global") {
    return ensureClaudeGlobalMcp(context);
  }

  const configPath = join(context.cwd, ".mcp.json");
  const current = await readJsonObject(configPath);
  const mcpServers = recordValue(current.mcpServers);
  if (isRecord(mcpServers.kyoso)) {
    return {
      kind: "mcp",
      registration: "preserved",
      title: "Claude Code MCP",
      status: "skipped",
      path: configPath,
      detail:
        mcpEntryStatus(mcpServers.kyoso) === "disabled"
          ? disabledClaudeMcpDetail(configPath)
          : "existing mcpServers.kyoso kept",
    };
  }

  const next = {
    ...current,
    mcpServers: {
      ...mcpServers,
      kyoso: buildClaudeMcpEntry(context.mcpCommand, context.withOpenRouter),
    },
  };
  const detail = diffForJson(configPath, current, next);
  if (!context.write) {
    return {
      kind: "mcp",
      registration: "generated",
      title: "Claude Code MCP",
      status: "dry-run",
      path: configPath,
      detail,
    };
  }

  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    kind: "mcp",
    registration: "generated",
    title: "Claude Code MCP",
    status: Object.keys(current).length > 0 ? "updated" : "created",
    path: configPath,
    detail,
  };
}

function ensureClaudeGlobalMcp(context: SetupContext): StepResult {
  const configPath = join(context.home, ".claude.json");
  const existingMcp = detectClaudeMcp(configPath, context.cwd, context.home);
  if (existingMcp.status !== "missing") {
    return {
      kind: "mcp",
      registration: "preserved",
      title: "Claude Code MCP",
      status: "skipped",
      path: configPath,
      detail:
        existingMcp.status === "disabled"
          ? disabledClaudeMcpDetail(configPath)
          : "existing mcpServers.kyoso kept",
    };
  }

  const json = JSON.stringify(
    buildClaudeMcpEntry(context.mcpCommand, context.withOpenRouter),
  );
  const args = ["mcp", "add-json", "kyoso", json, "--scope", "user"];
  const commandLine = ["claude", ...args.map(shellQuote)].join(" ");
  if (!context.write) {
    return {
      kind: "mcp",
      registration: "generated",
      title: "Claude Code MCP",
      status: "dry-run",
      path: configPath,
      detail: commandLine,
    };
  }

  const result = spawnSync("claude", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "claude mcp add-json failed",
    );
  }
  return {
    kind: "mcp",
    registration: "generated",
    title: "Claude Code MCP",
    status: "updated",
    path: configPath,
    detail: commandLine,
  };
}

async function ensureSkill(
  context: SetupContext,
  client: SetupClient,
  title: string,
): Promise<StepResult> {
  const result = await ensureManagedSkill({
    sourceDir: context.sourceSkillDir,
    destinationDir: skillDestination(
      client,
      context.scope,
      context.cwd,
      context.home,
    ),
    trustedRoot: context.scope === "global" ? context.home : context.cwd,
    write: context.write,
    force: context.force,
  });
  return {
    kind: "skill",
    title,
    ...result,
  };
}

function renderSetupOverview(context: SetupContext): string {
  const detected = detectSetup({
    cwd: context.cwd,
    home: context.home,
    codexHome: context.codexHome,
  });
  return [
    "Kyoso setup",
    "",
    "Clients",
    `  codex: MCP ${statusWord(detected.codex.mcp)}, skill ${statusWord(detected.codex.skill)}`,
    `  claude-code: MCP ${statusWord(detected["claude-code"].mcp)}, skill ${statusWord(detected["claude-code"].skill)}`,
    "",
    "Commands",
    "  kyoso setup codex [--write] [--with-openrouter] [--runner npx|bunx] [--command <command>] [--global] [--force]",
    "  kyoso setup claude-code [--write] [--with-openrouter] [--runner npx|bunx] [--command <command>] [--global] [--force]",
    "  kyoso setup codex --skill-only [--write] [--global] [--force]",
    "  kyoso setup claude-code --skill-only [--write] [--global] [--force]",
    "",
    `Default MCP command: ${context.mcpCommand.command} ${context.mcpCommand.args.join(" ")}`,
    "Dry-run is the default. Add --write to modify files.",
  ].join("\n");
}

function renderResults(context: SetupContext, results: StepResult[]): string {
  const mcpSteps = results.filter(
    (result): result is McpStepResult => result.kind === "mcp",
  );
  const includesGeneratedMcp = mcpSteps.some(
    (result) => result.registration === "generated",
  );
  const includesGeneratedCodexMcp = mcpSteps.some(
    (result) =>
      result.registration === "generated" && result.title === "Codex MCP",
  );
  const includesPreservedMcp = mcpSteps.some(
    (result) => result.registration === "preserved",
  );
  return [
    "Kyoso setup",
    "",
    ...results.flatMap((result) => [
      `${result.title}: ${result.status}${result.path ? ` (${result.path})` : ""}`,
      ...(result.detail ? indent(result.detail).split("\n") : []),
    ]),
    ...(mcpSteps.length > 0
      ? [
          "",
          "Credential scope",
          ...(includesGeneratedMcp
            ? [
                context.withOpenRouter
                  ? "  Newly generated and dry-run MCP registrations include OPENROUTER_API_KEY because --with-openrouter was set."
                  : "  Newly generated and dry-run MCP registrations omit OPENROUTER_API_KEY. Use --with-openrouter before writing a new registration to include it.",
              ]
            : []),
          ...(includesGeneratedCodexMcp
            ? [
                "  Newly generated and dry-run Codex MCP registrations intentionally forward CODEX_ACCESS_TOKEN for default Codex authentication; OpenRouter mode withholds it from the Codex child.",
              ]
            : []),
          ...(includesPreservedMcp
            ? [
                "  Existing MCP registrations were preserved unchanged; --with-openrouter does not edit them.",
              ]
            : []),
          "  Use --with-openrouter only when OpenRouter is intentionally selected.",
        ]
      : []),
  ].join("\n");
}

function parseClient(client: string | undefined): SetupClient | undefined {
  if (client === undefined) return undefined;
  if (client === "codex" || client === "claude-code") return client;
  throw new Error(
    `Invalid setup client "${client}". Expected codex or claude-code.`,
  );
}

function validateSkillOnlyOptions(
  options: SetupOptions,
  client: SetupClient | undefined,
): void {
  if (!options.skillOnly) return;
  if (!client) {
    throw new Error("--skill-only requires setup client codex or claude-code.");
  }
  if (options.runner !== undefined) {
    throw new Error("--skill-only cannot be combined with --runner.");
  }
  if (options.command !== undefined) {
    throw new Error("--skill-only cannot be combined with --command.");
  }
  if (options.withOpenRouter) {
    throw new Error("--skill-only cannot be combined with --with-openrouter.");
  }
}

function parseRunner(runner: string | undefined): SetupRunner {
  if (runner === undefined || runner === "npx") return "npx";
  if (runner === "bunx") return "bunx";
  throw new Error(`Invalid --runner value "${runner}". Expected npx or bunx.`);
}

function parseCommandSpec(value: string): McpCommand {
  const parts = splitCommand(value);
  const [command, ...args] = parts;
  if (!command) throw new Error("--command must not be empty");
  return { command, args };
}

function splitCommand(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("--command has an unterminated quote");
  if (current.length > 0) parts.push(current);
  return parts;
}

function resolveBundledSkillDir(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let current = start;
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, ".agents", "skills", "kyoso-review");
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
    current = dirname(current);
  }
  throw new Error("Bundled kyoso-review skill was not found in this package.");
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return "";
    throw error;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const content = await readOptionalFile(path);
  if (content.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function hasCodexMcpContent(content: string): boolean {
  return /^\s*\[mcp_servers\.(?:"kyoso"|kyoso)]\s*$/m.test(content);
}

function codexMcpStatusFromContent(content: string): ManualMcpStatus {
  try {
    const parsed = parse(content);
    if (!isRecord(parsed)) return "unknown";
    if (!isRecord(parsed.mcp_servers)) return "missing";
    if (!("kyoso" in parsed.mcp_servers)) return "missing";
    return mcpEntryStatus(parsed.mcp_servers.kyoso);
  } catch {
    return "unknown";
  }
}

function disabledCodexMcpDetail(configPath: string): string {
  return [
    "existing [mcp_servers.kyoso] is disabled and was kept unchanged.",
    `To re-enable it, edit ${configPath} and change enabled = false to enabled = true.`,
  ].join(" ");
}

function disabledClaudeMcpDetail(configPath: string): string {
  return [
    "existing mcpServers.kyoso is disabled and was kept unchanged.",
    `To re-enable it, edit ${configPath} and change \"enabled\": false to \"enabled\": true.`,
  ].join(" ");
}

type McpDetection = {
  status: ManualMcpStatus;
  paths: string[];
};

function detectCodexMcp(path: string, cwd: string, home: string): McpDetection {
  if (!existsSync(path)) return { status: "missing", paths: [] };

  try {
    const parsed = parse(readTextSync(path));
    if (hasUnprobedProjectIntegrationOverride(parsed, cwd, home)) {
      return { status: "unknown", paths: [path] };
    }
    if (!isRecord(parsed)) return { status: "unknown", paths: [path] };
    if (!("mcp_servers" in parsed)) return { status: "missing", paths: [] };
    if (!isRecord(parsed.mcp_servers)) {
      return { status: "unknown", paths: [path] };
    }
    if (!("kyoso" in parsed.mcp_servers)) {
      return { status: "missing", paths: [] };
    }
    return { status: mcpEntryStatus(parsed.mcp_servers.kyoso), paths: [path] };
  } catch {
    return { status: "unknown", paths: [path] };
  }
}

function detectClaudeMcp(
  path: string,
  cwd: string,
  home: string,
): McpDetection {
  if (!existsSync(path)) return { status: "missing", paths: [] };

  try {
    const parsed: unknown = JSON.parse(readTextSync(path));
    const statuses = jsonMcpStatuses(parsed, cwd, home);
    if (statuses.length === 0) return { status: "missing", paths: [] };
    return { status: mergeMcpStatuses(statuses), paths: [path] };
  } catch {
    return { status: "unknown", paths: [path] };
  }
}

function jsonMcpStatuses(
  value: unknown,
  cwd: string,
  home: string,
): ManualMcpStatus[] {
  if (!isRecord(value)) return ["unknown"];

  const statuses = directMcpStatuses(value);
  if (!("projects" in value)) return statuses;
  if (!isRecord(value.projects)) return [...statuses, "unknown"];

  const currentProject = normalizeProjectPath(cwd, home);
  for (const [projectPath, projectConfig] of Object.entries(value.projects)) {
    if (normalizeProjectPath(projectPath, home) !== currentProject) continue;
    if (!isRecord(projectConfig)) {
      statuses.push("unknown");
      continue;
    }
    statuses.push(...directMcpStatuses(projectConfig));
  }
  return statuses;
}

function directMcpStatuses(value: Record<string, unknown>): ManualMcpStatus[] {
  const statuses: ManualMcpStatus[] = [];
  if ("mcpServers" in value) {
    if (!isRecord(value.mcpServers)) {
      statuses.push("unknown");
    } else if ("kyoso" in value.mcpServers) {
      statuses.push(mcpEntryStatus(value.mcpServers.kyoso));
    }
  }
  return statuses;
}

function nestedMcpEntryStatus(value: unknown, path: string[]): ManualMcpStatus {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return "unknown";
    if (!(key in current)) return "missing";
    current = current[key];
  }
  return mcpEntryStatus(current);
}

function hasUnprobedProjectIntegrationOverride(
  value: unknown,
  cwd: string,
  home: string,
): boolean {
  if (!isRecord(value) || !isRecord(value.projects)) return false;
  const currentProject = normalizeProjectPath(cwd, home);
  for (const [projectPath, projectConfig] of Object.entries(value.projects)) {
    if (
      normalizeProjectPath(projectPath, home) !== currentProject ||
      !isRecord(projectConfig)
    ) {
      continue;
    }
    if ("mcp_servers" in projectConfig || "plugins" in projectConfig) {
      return true;
    }
  }
  return false;
}

function normalizeProjectPath(path: string, home: string): string | undefined {
  if (path.trim().length === 0) return undefined;
  const expanded =
    path === "~"
      ? home
      : path.startsWith("~/") || path.startsWith("~\\")
        ? join(home, path.slice(2))
        : path;
  const resolved = resolve(expanded);
  let normalized: string;
  try {
    normalized = realpathSync(resolved);
  } catch {
    normalized = resolved;
  }
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function mcpEntryStatus(value: unknown): ManualMcpStatus {
  if (!isRecord(value)) return "unknown";
  if (!("enabled" in value)) return "enabled";
  if (value.enabled === true) return "enabled";
  if (value.enabled === false) return "disabled";
  return "unknown";
}

function mergeMcpDetections(detections: McpDetection[]): McpDetection {
  return {
    status: mergeMcpStatuses(detections.map((detection) => detection.status)),
    paths: detections.flatMap((detection) => detection.paths),
  };
}

function mergeMcpStatuses(statuses: ManualMcpStatus[]): ManualMcpStatus {
  if (statuses.includes("enabled")) return "enabled";
  if (statuses.includes("unknown")) return "unknown";
  if (statuses.includes("disabled")) return "disabled";
  return "missing";
}

function existingSkillPaths(paths: string[]): string[] {
  return [...new Set(paths)].filter((path) =>
    existsSync(join(path, "SKILL.md")),
  );
}

function readTextSync(path: string): string {
  return readFileSync(path, "utf8");
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diffForAppend(path: string, snippet: string): string {
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@",
    ...snippet.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

function diffForJson(
  path: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const beforeText = JSON.stringify(before, null, 2).split("\n");
  const afterText = JSON.stringify(after, null, 2).split("\n");
  return [
    `--- ${path}`,
    `+++ ${path}`,
    "@@",
    ...beforeText.map((line) => `-${line}`),
    ...afterText.map((line) => `+${line}`),
  ].join("\n");
}

function statusWord(value: boolean): string {
  return value ? "ok" : "missing";
}

function singleAgentAdvice(
  context: SetupContext,
  client: SetupClient,
): StepResult[] {
  if (client === "claude-code" && !commandExists("codex", context.env)) {
    return [
      {
        kind: "advice",
        title: "Single-agent config",
        status: "skipped",
        detail: [
          "codex was not found on PATH. To use Claude only, add:",
          "agents: {",
          "  codex: { enabled: false },",
          "}",
          "Claude will run as combined_reviewer and cross-model verification will be marked unavailable.",
        ].join("\n"),
      },
    ];
  }
  if (client === "codex" && !commandExists("claude", context.env)) {
    return [
      {
        kind: "advice",
        title: "Single-agent config",
        status: "skipped",
        detail: [
          "claude was not found on PATH. To use Codex only, add:",
          "agents: {",
          "  claude: { enabled: false },",
          "}",
          "Codex will run as combined_reviewer and cross-model verification will be marked unavailable.",
        ].join("\n"),
      },
    ];
  }
  return [];
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@{}$,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const paths = env.PATH?.split(delimiter) ?? [];
  return paths.some((path) => existsSync(join(path, command)));
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
