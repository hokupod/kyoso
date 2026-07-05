import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SetupClient = "codex" | "claude-code";
export type SetupRunner = "npx" | "bunx";
export type SetupScope = "project" | "global";

export type SetupOptions = {
  cwd: string;
  client?: string;
  write: boolean;
  global: boolean;
  runner?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
};

type McpCommand = {
  command: string;
  args: string[];
};

type StepResult = {
  title: string;
  status: "dry-run" | "created" | "updated" | "skipped";
  path?: string;
  detail?: string;
};

type SetupContext = {
  cwd: string;
  home: string;
  write: boolean;
  scope: SetupScope;
  mcpCommand: McpCommand;
  sourceSkillDir: string;
};

export async function runSetup(options: SetupOptions): Promise<string> {
  const client = parseClient(options.client);
  const runner = parseRunner(options.runner);
  const command = options.command
    ? parseCommandSpec(options.command)
    : commandForRunner(runner);
  const context: SetupContext = {
    cwd: options.cwd,
    home: options.env?.HOME ?? homedir(),
    write: options.write,
    scope: options.global ? "global" : "project",
    mcpCommand: command,
    sourceSkillDir: resolveBundledSkillDir(),
  };

  if (!client) return renderSetupOverview(context);
  if (client === "codex") return renderResults(await setupCodex(context));
  return renderResults(await setupClaudeCode(context));
}

export function commandForRunner(runner: SetupRunner): McpCommand {
  if (runner === "bunx") {
    return { command: "bunx", args: ["@kyo-so/cli", "mcp"] };
  }
  return { command: "npx", args: ["-y", "@kyo-so/cli", "mcp"] };
}

export function buildCodexMcpToml(command: McpCommand): string {
  return [
    "[mcp_servers.kyoso]",
    `command = ${JSON.stringify(command.command)}`,
    `args = ${JSON.stringify(command.args)}`,
    'env_vars = ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]',
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 360",
    "enabled = true",
    "",
  ].join("\n");
}

export function buildClaudeMcpEntry(
  command: McpCommand,
): Record<string, unknown> {
  return {
    command: command.command,
    args: command.args,
    env: {
      OPENAI_API_KEY: "${OPENAI_API_KEY}",
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
      CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}",
    },
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

export function detectSetup(options: {
  cwd: string;
  home?: string;
}): Record<SetupClient, { mcp: boolean; skill: boolean }> {
  const home = options.home ?? homedir();
  return {
    codex: {
      mcp: hasCodexMcp(join(home, ".codex", "config.toml")),
      skill:
        existsSync(
          join(options.cwd, ".agents", "skills", "kyoso-review", "SKILL.md"),
        ) ||
        existsSync(join(home, ".agents", "skills", "kyoso-review", "SKILL.md")),
    },
    "claude-code": {
      mcp:
        hasClaudeMcp(join(options.cwd, ".mcp.json")) ||
        hasClaudeMcp(join(home, ".claude.json")),
      skill:
        existsSync(
          join(options.cwd, ".claude", "skills", "kyoso-review", "SKILL.md"),
        ) ||
        existsSync(join(home, ".claude", "skills", "kyoso-review", "SKILL.md")),
    },
  };
}

async function setupCodex(context: SetupContext): Promise<StepResult[]> {
  return [
    await ensureCodexMcp(context),
    await ensureSkill({
      title: "Codex skill",
      sourceDir: context.sourceSkillDir,
      destinationDir: skillDestination(
        "codex",
        context.scope,
        context.cwd,
        context.home,
      ),
      write: context.write,
    }),
  ];
}

async function setupClaudeCode(context: SetupContext): Promise<StepResult[]> {
  return [
    await ensureClaudeMcp(context),
    await ensureSkill({
      title: "Claude Code skill",
      sourceDir: context.sourceSkillDir,
      destinationDir: skillDestination(
        "claude-code",
        context.scope,
        context.cwd,
        context.home,
      ),
      write: context.write,
    }),
  ];
}

async function ensureCodexMcp(context: SetupContext): Promise<StepResult> {
  const configPath = join(context.home, ".codex", "config.toml");
  const snippet = buildCodexMcpToml(context.mcpCommand);
  const current = await readOptionalFile(configPath);
  if (hasCodexMcpContent(current)) {
    return {
      title: "Codex MCP",
      status: "skipped",
      path: configPath,
      detail: "existing [mcp_servers.kyoso] kept",
    };
  }
  const detail = diffForAppend(configPath, snippet);
  if (!context.write) {
    return { title: "Codex MCP", status: "dry-run", path: configPath, detail };
  }
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n\n" : "";
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${current}${separator}${snippet}`, "utf8");
  return {
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
      title: "Claude Code MCP",
      status: "skipped",
      path: configPath,
      detail: "existing mcpServers.kyoso kept",
    };
  }

  const next = {
    ...current,
    mcpServers: {
      ...mcpServers,
      kyoso: buildClaudeMcpEntry(context.mcpCommand),
    },
  };
  const detail = diffForJson(configPath, current, next);
  if (!context.write) {
    return {
      title: "Claude Code MCP",
      status: "dry-run",
      path: configPath,
      detail,
    };
  }

  await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return {
    title: "Claude Code MCP",
    status: Object.keys(current).length > 0 ? "updated" : "created",
    path: configPath,
    detail,
  };
}

function ensureClaudeGlobalMcp(context: SetupContext): StepResult {
  const configPath = join(context.home, ".claude.json");
  if (hasClaudeMcp(configPath)) {
    return {
      title: "Claude Code MCP",
      status: "skipped",
      path: configPath,
      detail: "existing mcpServers.kyoso kept",
    };
  }

  const json = JSON.stringify(buildClaudeMcpEntry(context.mcpCommand));
  const args = ["mcp", "add-json", "kyoso", json, "--scope", "user"];
  const commandLine = ["claude", ...args.map(shellQuote)].join(" ");
  if (!context.write) {
    return {
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
    title: "Claude Code MCP",
    status: "updated",
    path: configPath,
    detail: commandLine,
  };
}

async function ensureSkill(options: {
  title: string;
  sourceDir: string;
  destinationDir: string;
  write: boolean;
}): Promise<StepResult> {
  const destinationSkill = join(options.destinationDir, "SKILL.md");
  if (existsSync(destinationSkill)) {
    return {
      title: options.title,
      status: "skipped",
      path: options.destinationDir,
      detail: "existing kyoso-review skill kept",
    };
  }

  const detail = [
    `copy ${options.sourceDir}`,
    `to   ${options.destinationDir}`,
  ].join("\n");
  if (!options.write) {
    return {
      title: options.title,
      status: "dry-run",
      path: options.destinationDir,
      detail,
    };
  }

  await mkdir(dirname(options.destinationDir), { recursive: true });
  await cp(options.sourceDir, options.destinationDir, {
    recursive: true,
    force: false,
  });
  return {
    title: options.title,
    status: "created",
    path: options.destinationDir,
    detail,
  };
}

function renderSetupOverview(context: SetupContext): string {
  const detected = detectSetup({ cwd: context.cwd, home: context.home });
  return [
    "Kyoso setup",
    "",
    "Clients",
    `  codex: MCP ${statusWord(detected.codex.mcp)}, skill ${statusWord(detected.codex.skill)}`,
    `  claude-code: MCP ${statusWord(detected["claude-code"].mcp)}, skill ${statusWord(detected["claude-code"].skill)}`,
    "",
    "Commands",
    "  kyoso setup codex [--write] [--runner npx|bunx] [--global]",
    "  kyoso setup claude-code [--write] [--runner npx|bunx] [--global]",
    "",
    `Default MCP command: ${context.mcpCommand.command} ${context.mcpCommand.args.join(" ")}`,
    "Dry-run is the default. Add --write to modify files.",
  ].join("\n");
}

function renderResults(results: StepResult[]): string {
  return [
    "Kyoso setup",
    "",
    ...results.flatMap((result) => [
      `${result.title}: ${result.status}${result.path ? ` (${result.path})` : ""}`,
      ...(result.detail ? indent(result.detail).split("\n") : []),
    ]),
  ].join("\n");
}

function parseClient(client: string | undefined): SetupClient | undefined {
  if (client === undefined) return undefined;
  if (client === "codex" || client === "claude-code") return client;
  throw new Error(
    `Invalid setup client "${client}". Expected codex or claude-code.`,
  );
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

function hasCodexMcp(path: string): boolean {
  return existsSync(path) && hasCodexMcpContent(readTextSync(path));
}

function hasCodexMcpContent(content: string): boolean {
  return /^\s*\[mcp_servers\.(?:"kyoso"|kyoso)]\s*$/m.test(content);
}

function hasClaudeMcp(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readTextSync(path));
    return jsonHasKyosoMcp(parsed);
  } catch {
    return false;
  }
}

function jsonHasKyosoMcp(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (isRecord(value.mcpServers) && isRecord(value.mcpServers.kyoso)) {
    return true;
  }
  return Object.values(value).some((child) => jsonHasKyosoMcp(child));
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
