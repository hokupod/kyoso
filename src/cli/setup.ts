import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  inspectManualMcpInvocation,
  type ManualMcpInvocationInspection,
} from "./manualMcpInvocation.js";
import {
  buildKyosoPackageCommand,
  formatKyosoPackageCommand,
  isCompleteSemVer,
  KYOSO_PACKAGE_NAME,
  type KyosoPackageRunner,
} from "./packageRunner.js";
import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import { ensureManagedSkill } from "./skillInstall.js";

export type SetupClient = "codex" | "claude-code";
export type SetupRunner = KyosoPackageRunner;
export type SetupScope = "project" | "global";
export type ManualMcpStatus = "enabled" | "disabled" | "missing" | "unknown";

export type ManualMcpScope =
  "codex-global" | "claude-project" | "claude-global" | "claude-global-project";

export type ManualMcpRegistration = {
  path: string;
  scope: ManualMcpScope;
  status: ManualMcpStatus;
  invocation: ManualMcpInvocationInspection;
  autoMigrationEligible: boolean;
};

export type SetupDetection = {
  mcp: boolean;
  skill: boolean;
  manualMcpStatus: ManualMcpStatus;
  manualMcpRegistrations: ManualMcpRegistration[];
  mcpPaths: string[];
  skillPaths: string[];
};

export type BunxVersionProbeResult =
  | { status: "verified"; version: string }
  | {
      status: "missing" | "failed" | "timeout" | "invalid" | "unsupported";
      detail: string;
    };

export type BunxVersionProbe = (options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => BunxVersionProbeResult;

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
  bunxVersionProbe?: BunxVersionProbe;
  beforeManualMcpWrite?: (path: string) => void | Promise<void>;
  beforeManualMcpCommit?: (path: string) => void | Promise<void>;
  afterManualMcpValidation?: (path: string) => void | Promise<void>;
  beforeManualMcpRename?: (path: string) => void | Promise<void>;
  manualMcpRename?: (source: string, destination: string) => Promise<void>;
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
  registration: "blocked" | "generated" | "migrated" | "preserved";
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
  customCommand: boolean;
  runnerExplicit: boolean;
  mcpCommand: McpCommand;
  bunxVersionProbe: BunxVersionProbe;
  bunxProbe?: BunxVersionProbeResult;
  beforeManualMcpWrite?: (path: string) => void | Promise<void>;
  beforeManualMcpCommit?: (path: string) => void | Promise<void>;
  afterManualMcpValidation?: (path: string) => void | Promise<void>;
  beforeManualMcpRename?: (path: string) => void | Promise<void>;
  manualMcpRename: (source: string, destination: string) => Promise<void>;
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
    customCommand: options.command !== undefined,
    runnerExplicit: options.runner !== undefined,
    mcpCommand: command,
    bunxVersionProbe: options.bunxVersionProbe ?? probeBunxVersion,
    beforeManualMcpWrite: options.beforeManualMcpWrite,
    beforeManualMcpCommit: options.beforeManualMcpCommit,
    afterManualMcpValidation: options.afterManualMcpValidation,
    beforeManualMcpRename: options.beforeManualMcpRename,
    manualMcpRename: options.manualMcpRename ?? rename,
    sourceSkillDir: resolveBundledSkillDir(),
  };

  if (!client) return renderSetupOverview(context);
  if (client === "codex") {
    return renderResults(context, await setupCodex(context));
  }
  return renderResults(context, await setupClaudeCode(context));
}

export function commandForRunner(runner: SetupRunner): McpCommand {
  return buildKyosoPackageCommand({ runner, cliArgs: ["mcp"] });
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
    "tool_timeout_sec = 2160",
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
      mcp: isCurrentManualMcp(codexMcp),
      skill: codexSkillPaths.length > 0,
      manualMcpStatus: codexMcp.status,
      manualMcpRegistrations: codexMcp.registrations,
      mcpPaths: codexMcp.paths,
      skillPaths: codexSkillPaths,
    },
    "claude-code": {
      mcp: isCurrentManualMcp(claudeMcp),
      skill: claudeSkillPaths.length > 0,
      manualMcpStatus: claudeMcp.status,
      manualMcpRegistrations: claudeMcp.registrations,
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
  const existing = inspectCodexMcpContent(
    current,
    configPath,
    context.cwd,
    context.home,
  );
  if (existing) {
    return ensureExistingCodexMcp(context, current, existing);
  }
  const appendSafety = inspectCodexAppendSafety(
    current,
    context.cwd,
    context.home,
  );
  if (!appendSafety.ok) {
    return {
      kind: "mcp",
      registration: "blocked",
      title: "Codex MCP",
      status: "conflict",
      path: configPath,
      detail: appendSafety.detail,
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
      detail: `${detail}${bunxVerificationPendingDetail(context, context.mcpCommand)}`,
    };
  }
  const unsupportedBunx = unsupportedBunxResult(
    context,
    "Codex MCP",
    configPath,
    context.mcpCommand,
  );
  if (unsupportedBunx) return unsupportedBunx;
  if (context.bunxProbe?.status === "verified") {
    const latest = await readOptionalFile(configPath);
    if (latest !== current) {
      return migrationConflictResult(
        "Codex MCP",
        configPath,
        "Codex MCP config changed while bunx verification; it was not overwritten.",
      );
    }
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
  const userConfig = detectClaudeMcp(
    join(context.home, ".claude.json"),
    context.cwd,
    context.home,
  );
  const applicableUserRegistrations = userConfig.registrations.filter(
    (registration) => registration.status !== "disabled",
  );
  if (applicableUserRegistrations.length > 0) {
    return claudeProjectMcpScopeConflictResult(configPath, {
      ...userConfig,
      registrations: applicableUserRegistrations,
      paths: [
        ...new Set(
          applicableUserRegistrations.map((registration) => registration.path),
        ),
      ],
    });
  }
  const content = await readOptionalFile(configPath);
  let current: Record<string, unknown>;
  try {
    current = parseJsonObject(configPath, content);
  } catch (error) {
    return {
      kind: "mcp",
      registration: "blocked",
      title: "Claude Code MCP",
      status: "conflict",
      path: configPath,
      detail: `Claude Code MCP config could not be parsed and was left unchanged: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const mcpServers = recordValue(current.mcpServers);
  const existing = inspectClaudeProjectMcp(current, configPath);
  if (existing) {
    return ensureExistingClaudeProjectMcp(context, content, existing);
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
      detail: `${detail}${bunxVerificationPendingDetail(context, context.mcpCommand)}`,
    };
  }

  const unsupportedBunx = unsupportedBunxResult(
    context,
    "Claude Code MCP",
    configPath,
    context.mcpCommand,
  );
  if (unsupportedBunx) return unsupportedBunx;
  if (context.bunxProbe?.status === "verified") {
    const latest = await readOptionalFile(configPath);
    if (latest !== content) {
      return migrationConflictResult(
        "Claude Code MCP",
        configPath,
        "Claude Code MCP config changed while bunx verification; it was not overwritten.",
      );
    }
  }

  await mkdir(dirname(configPath), { recursive: true });
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

async function ensureExistingCodexMcp(
  context: SetupContext,
  current: string,
  existing: ManualMcpRegistration,
): Promise<StepResult> {
  if (existing.invocation.kind !== "legacy") {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      codexPreservedDetail(existing),
    );
  }
  const replacement = migrationReplacementForContext(
    context,
    existing.invocation,
  );
  if (!replacement) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      codexPreservedDetail(existing),
    );
  }
  const detail = legacyMigrationDetail(
    existing.path,
    existing.invocation,
    replacement,
  );
  if (!context.write) {
    return {
      kind: "mcp",
      registration: "preserved",
      title: "Codex MCP",
      status: "dry-run",
      path: existing.path,
      detail: `${detail}${bunxVerificationPendingDetail(context, replacement)}`,
    };
  }
  if (!context.force || context.customCommand) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      `${detail}\nLegacy registration was kept. Re-run with --write --force to migrate this exact invocation.`,
    );
  }
  if (requiresExplicitBunxRunnerForMigration(context, replacement)) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      `${detail}\nLegacy Bun registration was kept. Re-run with --write --runner bunx --force to verify and migrate this exact invocation, or with --runner npx --force to migrate it using npx.`,
    );
  }
  const unsupportedBunx = unsupportedBunxResult(
    context,
    "Codex MCP",
    existing.path,
    replacement,
    { migration: true },
  );
  if (unsupportedBunx) return unsupportedBunx;
  const safety = await inspectMigrationFile(existing.path);
  if (!safety.ok) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      `${detail}\n${safety.detail}`,
    );
  }
  if (context.beforeManualMcpWrite) {
    await context.beforeManualMcpWrite(existing.path);
  }
  const latest = await readOptionalFile(existing.path);
  if (latest !== current) {
    return migrationConflictResult(
      "Codex MCP",
      existing.path,
      "Codex MCP config changed after inspection; it was not overwritten.",
    );
  }
  const next = patchCodexLegacyInvocation(latest, replacement);
  if (!next) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      `${detail}\nThe TOML shape is not a safe single-line legacy target; migrate it manually.`,
    );
  }
  const verified = inspectCodexMcpContent(
    next,
    existing.path,
    context.cwd,
    context.home,
  );
  if (!isCurrentMcpCommand(verified?.invocation, replacement)) {
    return preservedMcpResult(
      "Codex MCP",
      existing,
      `${detail}\nThe proposed TOML patch could not be verified; it was not written.`,
    );
  }
  try {
    await writeFileAtomically(existing.path, next, safety.safety, latest, {
      beforeCommit: context.beforeManualMcpCommit,
      afterExpectedContentsCheck: context.afterManualMcpValidation,
      beforeRename: context.beforeManualMcpRename,
      replace: context.manualMcpRename,
    });
  } catch (error) {
    if (error instanceof MigrationCommittedError) {
      return migrationConflictResult(
        "Codex MCP",
        existing.path,
        "Codex MCP migration may have been committed but could not be verified; inspect the current config before retrying.",
      );
    }
    if (error instanceof MigrationConflictError) {
      return migrationConflictResult(
        "Codex MCP",
        existing.path,
        "Codex MCP config changed before migration could be committed; it was not overwritten.",
      );
    }
    throw error;
  }
  return {
    kind: "mcp",
    registration: "migrated",
    title: "Codex MCP",
    status: "updated",
    path: existing.path,
    detail:
      "migrated exact legacy [mcp_servers.kyoso] invocation to explicit package/executable args",
  };
}

async function ensureExistingClaudeProjectMcp(
  context: SetupContext,
  content: string,
  existing: ManualMcpRegistration,
): Promise<StepResult> {
  if (existing.invocation.kind !== "legacy") {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      claudePreservedDetail(existing),
    );
  }
  const replacement = migrationReplacementForContext(
    context,
    existing.invocation,
  );
  if (!replacement) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      claudePreservedDetail(existing),
    );
  }
  const detail = legacyMigrationDetail(
    existing.path,
    existing.invocation,
    replacement,
  );
  if (!context.write) {
    return {
      kind: "mcp",
      registration: "preserved",
      title: "Claude Code MCP",
      status: "dry-run",
      path: existing.path,
      detail: `${detail}${bunxVerificationPendingDetail(context, replacement)}`,
    };
  }
  if (!context.force || context.customCommand) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      `${detail}\nLegacy registration was kept. Re-run with --write --force to migrate this exact invocation.`,
    );
  }
  if (requiresExplicitBunxRunnerForMigration(context, replacement)) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      `${detail}\nLegacy Bun registration was kept. Re-run with --write --runner bunx --force to verify and migrate this exact invocation, or with --runner npx --force to migrate it using npx.`,
    );
  }
  const unsupportedBunx = unsupportedBunxResult(
    context,
    "Claude Code MCP",
    existing.path,
    replacement,
    { migration: true },
  );
  if (unsupportedBunx) return unsupportedBunx;
  const safety = await inspectMigrationFile(existing.path);
  if (!safety.ok) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      `${detail}\n${safety.detail}`,
    );
  }
  if (context.beforeManualMcpWrite) {
    await context.beforeManualMcpWrite(existing.path);
  }
  const latest = await readOptionalFile(existing.path);
  if (latest !== content) {
    return migrationConflictResult(
      "Claude Code MCP",
      existing.path,
      "Claude Code MCP config changed after inspection; it was not overwritten.",
    );
  }
  const next = patchClaudeProjectMcpInvocation(latest, replacement);
  if (!next) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      `${detail}\nThe JSON shape is not a safe exact legacy target; migrate it manually.`,
    );
  }
  const verified = inspectClaudeProjectMcp(
    parseJsonObject(existing.path, next),
    existing.path,
  );
  if (!isCurrentMcpCommand(verified?.invocation, replacement)) {
    return preservedMcpResult(
      "Claude Code MCP",
      existing,
      `${detail}\nThe proposed JSON patch could not be verified; it was not written.`,
    );
  }
  try {
    await writeFileAtomically(existing.path, next, safety.safety, latest, {
      beforeCommit: context.beforeManualMcpCommit,
      afterExpectedContentsCheck: context.afterManualMcpValidation,
      beforeRename: context.beforeManualMcpRename,
      replace: context.manualMcpRename,
    });
  } catch (error) {
    if (error instanceof MigrationCommittedError) {
      return migrationConflictResult(
        "Claude Code MCP",
        existing.path,
        "Claude Code MCP migration may have been committed but could not be verified; inspect the current config before retrying.",
      );
    }
    if (error instanceof MigrationConflictError) {
      return migrationConflictResult(
        "Claude Code MCP",
        existing.path,
        "Claude Code MCP config changed before migration could be committed; it was not overwritten.",
      );
    }
    throw error;
  }
  return {
    kind: "mcp",
    registration: "migrated",
    title: "Claude Code MCP",
    status: "updated",
    path: existing.path,
    detail:
      "migrated exact legacy mcpServers.kyoso invocation to explicit package/executable args",
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
          : claudeGlobalMcpPreservedDetail(existingMcp),
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
      detail: `${commandLine}${bunxVerificationPendingDetail(context, context.mcpCommand)}`,
    };
  }

  const unsupportedBunx = unsupportedBunxResult(
    context,
    "Claude Code MCP",
    configPath,
    context.mcpCommand,
  );
  if (unsupportedBunx) return unsupportedBunx;

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

function claudeGlobalMcpPreservedDetail(detection: McpDetection): string {
  if (detection.registrations.length !== 1) {
    return "Multiple existing mcpServers.kyoso registrations were kept; their effective precedence is not inferred.";
  }
  const registration = detection.registrations[0];
  if (registration?.invocation.kind !== "legacy") {
    return "existing mcpServers.kyoso kept";
  }
  const scope =
    registration.scope === "claude-global"
      ? "user"
      : "project-scoped user-config";
  return `existing ${scope} mcpServers.kyoso uses legacy package-runner arguments and was kept. Automatic migration supports only a project .mcp.json; update ${registration.path} manually.`;
}

function claudeProjectMcpScopeConflictResult(
  projectPath: string,
  userConfig: McpDetection,
): StepResult {
  return {
    kind: "mcp",
    registration: "preserved",
    title: "Claude Code MCP",
    status: "skipped",
    path: projectPath,
    detail: `Claude user-config MCP registration${userConfig.registrations.length === 1 ? "" : "s"} at ${userConfig.paths.join(", ")} ${userConfig.registrations.length === 1 ? "was" : "were"} kept. Project setup does not infer effective precedence; update the intended scope manually.`,
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
    `  codex: MCP ${setupOverviewMcpStatus(detected.codex, context)}, skill ${statusWord(detected.codex.skill)}`,
    `  claude-code: MCP ${setupOverviewMcpStatus(detected["claude-code"], context)}, skill ${statusWord(detected["claude-code"].skill)}`,
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

function setupOverviewMcpStatus(
  detection: SetupDetection,
  context: SetupContext,
): string {
  if (detection.manualMcpStatus === "missing") return "missing";
  if (detection.manualMcpRegistrations.length !== 1) return "unverified";
  const registration = detection.manualMcpRegistrations[0];
  if (!registration) return "unverified";
  if (registration.status === "disabled") return "disabled";
  if (registration.status !== "enabled") return "unverified";
  const invocation = registration.invocation;
  if (invocation.kind === "legacy") return "repair required (legacy)";
  if (invocation.kind === "custom") return "custom/unverified";
  if (invocation.kind !== "current") return "unverified";
  if (invocation.runner === "npx") {
    return commandExists("npx", context.env) ? "ok" : "npx missing";
  }
  if (invocation.runner === "bunx") {
    return commandExists("bunx", context.env)
      ? "bunx unverified"
      : "bunx missing";
  }
  return "unverified";
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

function parseJsonObject(
  path: string,
  content: string,
): Record<string, unknown> {
  if (content.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed;
}

function inspectCodexAppendSafety(
  content: string,
  cwd: string,
  home: string,
): { ok: true } | { ok: false; detail: string } {
  if (content.trim().length === 0) return { ok: true };
  try {
    const parsed = parse(content);
    if (!isRecord(parsed)) {
      return {
        ok: false,
        detail: "Codex config is not a TOML object and was left unchanged.",
      };
    }
    if (hasUnprobedProjectIntegrationOverride(parsed, cwd, home)) {
      return {
        ok: false,
        detail:
          "Codex has a project-scoped MCP or Plugin override; the global config was left unchanged.",
      };
    }
    if ("mcp_servers" in parsed && !isRecord(parsed.mcp_servers)) {
      return {
        ok: false,
        detail: "Codex mcp_servers is malformed and was left unchanged.",
      };
    }
    if (isRecord(parsed.mcp_servers) && "kyoso" in parsed.mcp_servers) {
      return {
        ok: false,
        detail:
          "Codex already defines mcp_servers.kyoso in a form setup cannot safely extend; migrate it manually.",
      };
    }
    if (hasTomlMcpServersAssignment(content)) {
      return {
        ok: false,
        detail:
          "Codex defines mcp_servers with an inline assignment setup cannot safely extend; add the registration manually.",
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      detail: "Codex config could not be parsed and was left unchanged.",
    };
  }
}

function hasTomlMcpServersAssignment(content: string): boolean {
  return /^[ \t]*(?:mcp_servers|"mcp_servers")[ \t]*=/m.test(content);
}

function inspectCodexMcpContent(
  content: string,
  path: string,
  cwd: string,
  home: string,
): ManualMcpRegistration | undefined {
  if (!hasCodexMcpContent(content)) return undefined;
  try {
    const parsed = parse(content);
    if (hasUnprobedProjectIntegrationOverride(parsed, cwd, home)) {
      return manualMcpRegistration({
        path,
        scope: "codex-global",
        status: "unknown",
        value: undefined,
      });
    }
    if (!isRecord(parsed) || !isRecord(parsed.mcp_servers)) {
      return manualMcpRegistration({
        path,
        scope: "codex-global",
        status: "unknown",
        value: undefined,
      });
    }
    if (!("kyoso" in parsed.mcp_servers)) return undefined;
    return manualMcpRegistration({
      path,
      scope: "codex-global",
      status: mcpEntryStatus(parsed.mcp_servers.kyoso),
      value: parsed.mcp_servers.kyoso,
    });
  } catch {
    return manualMcpRegistration({
      path,
      scope: "codex-global",
      status: "unknown",
      value: undefined,
    });
  }
}

function inspectClaudeProjectMcp(
  current: Record<string, unknown>,
  path: string,
): ManualMcpRegistration | undefined {
  if (!("mcpServers" in current)) return undefined;
  if (!isRecord(current.mcpServers)) {
    return manualMcpRegistration({
      path,
      scope: "claude-project",
      status: "unknown",
      value: undefined,
    });
  }
  if (!("kyoso" in current.mcpServers)) return undefined;
  return manualMcpRegistration({
    path,
    scope: "claude-project",
    status: mcpEntryStatus(current.mcpServers.kyoso),
    value: current.mcpServers.kyoso,
  });
}

function manualMcpRegistration(options: {
  path: string;
  scope: ManualMcpScope;
  status: ManualMcpStatus;
  value: unknown;
}): ManualMcpRegistration {
  const { value, ...registration } = options;
  const invocation = inspectManualMcpInvocation(value);
  return {
    ...registration,
    invocation,
    autoMigrationEligible:
      (options.scope === "codex-global" ||
        options.scope === "claude-project") &&
      invocation.kind === "legacy",
  };
}

function preservedMcpResult(
  title: string,
  registration: ManualMcpRegistration,
  detail: string,
): StepResult {
  return {
    kind: "mcp",
    registration: "preserved",
    title,
    status: "skipped",
    path: registration.path,
    detail,
  };
}

function codexPreservedDetail(registration: ManualMcpRegistration): string {
  if (registration.status === "disabled") {
    return disabledCodexMcpDetail(registration.path);
  }
  if (registration.invocation.kind === "current") {
    return "existing [mcp_servers.kyoso] uses the current explicit package/executable invocation and was kept.";
  }
  if (registration.invocation.kind === "legacy") {
    return "existing [mcp_servers.kyoso] uses a legacy invocation and was kept unchanged.";
  }
  return `existing [mcp_servers.kyoso] is ${formatInvocationKind(registration.invocation.kind)} and was kept unchanged. ${registration.invocation.reason}`;
}

function claudePreservedDetail(registration: ManualMcpRegistration): string {
  if (registration.status === "disabled") {
    return disabledClaudeMcpDetail(registration.path);
  }
  if (registration.invocation.kind === "current") {
    return "existing mcpServers.kyoso uses the current explicit package/executable invocation and was kept.";
  }
  if (registration.invocation.kind === "legacy") {
    return "existing mcpServers.kyoso uses a legacy invocation and was kept unchanged.";
  }
  return `existing mcpServers.kyoso is ${formatInvocationKind(registration.invocation.kind)} and was kept unchanged. ${registration.invocation.reason}`;
}

function formatInvocationKind(
  kind: ManualMcpInvocationInspection["kind"],
): string {
  if (kind === "custom") return "custom/unverified";
  return kind;
}

function legacyMigrationDetail(
  path: string,
  invocation: ManualMcpInvocationInspection,
  replacement: McpCommand,
): string {
  const legacyArgs = invocation.legacyArgs;
  if (!invocation.runner || !legacyArgs) {
    return "legacy package-runner invocation detected; only --write --force may migrate it. The migration preview is unavailable because its exact command arguments could not be reconstructed.";
  }
  return [
    "legacy package-runner invocation detected; only --write --force may migrate it.",
    `--- ${formatMigrationPreviewValue(path)}`,
    `+++ ${formatMigrationPreviewValue(path)}`,
    "@@ Kyoso MCP invocation",
    `- command = ${formatMigrationPreviewValue(invocation.runner)}`,
    `- args = ${formatMigrationPreviewArgs(legacyArgs)}`,
    `+ command = ${formatMigrationPreviewValue(replacement.command)}`,
    `+ args = ${formatMigrationPreviewArgs(replacement.args)}`,
    "Only the Kyoso command and arguments are shown; other configuration values remain unchanged.",
  ].join("\n");
}

function patchCodexLegacyInvocation(
  content: string,
  replacement: McpCommand,
): string | undefined {
  const tableMatches = [
    ...content.matchAll(/^\s*\[mcp_servers\.(?:"kyoso"|kyoso)]\s*$/gm),
  ];
  if (tableMatches.length !== 1) return undefined;
  const table = tableMatches[0];
  if (table?.index === undefined) return undefined;
  const bodyStart = table.index + table[0].length;
  const remaining = content.slice(bodyStart);
  const nextTableOffset = remaining.search(/^\s*\[/m);
  const bodyEnd =
    nextTableOffset === -1 ? content.length : bodyStart + nextTableOffset;
  const body = content.slice(bodyStart, bodyEnd);
  const commandMatches = [
    ...body.matchAll(
      /^([ \t]*command[ \t]*=[ \t]*)"[^"\r\n]*"([ \t]*(?:#.*)?)(\r?\n|$)/gm,
    ),
  ];
  const argsMatches = [
    ...body.matchAll(/^([ \t]*args[ \t]*=[ \t]*)([^\r\n]*)(\r?\n|$)/gm),
  ];
  if (commandMatches.length !== 1 || argsMatches.length !== 1) return undefined;
  const argsMatch = argsMatches[0];
  const argsLine = argsMatch?.[0];
  const argsPrefix = argsMatch?.[1];
  const argsValue = argsMatch?.[2];
  const argsNewline = argsMatch?.[3];
  if (
    argsLine === undefined ||
    argsPrefix === undefined ||
    argsValue === undefined ||
    argsNewline === undefined
  ) {
    return undefined;
  }
  const patchedArgsValue = patchTomlInlineArrayValue(
    argsValue,
    replacement.args,
  );
  if (patchedArgsValue === undefined) return undefined;
  const commandPatched = body.replace(
    /^([ \t]*command[ \t]*=[ \t]*)"[^"\r\n]*"([ \t]*(?:#.*)?)(\r?\n|$)/m,
    (_line, prefix: string, suffix: string, newline: string) =>
      `${prefix}${JSON.stringify(replacement.command)}${suffix}${newline}`,
  );
  const nextBody = commandPatched.replace(
    argsLine,
    `${argsPrefix}${patchedArgsValue}${argsNewline}`,
  );
  return `${content.slice(0, bodyStart)}${nextBody}${content.slice(bodyEnd)}`;
}

function patchTomlInlineArrayValue(
  value: string,
  replacement: string[],
): string | undefined {
  const closingIndex = tomlInlineArrayClosingIndex(value);
  if (closingIndex === undefined) return undefined;
  const suffix = value.slice(closingIndex + 1);
  if (!/^[ \t]*(?:#.*)?$/.test(suffix)) return undefined;
  return `${JSON.stringify(replacement)}${suffix}`;
}

function tomlInlineArrayClosingIndex(value: string): number | undefined {
  if (!value.startsWith("[")) return undefined;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === undefined) return undefined;
    if (quote) {
      if (quote === '"' && character === "\\") {
        index += 1;
        continue;
      }
      if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          index += 1;
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character === "]") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function isCurrentMcpCommand(
  invocation: ManualMcpInvocationInspection | undefined,
  replacement: McpCommand,
): boolean {
  if (
    invocation?.kind !== "current" ||
    invocation.runner !== replacement.command
  ) {
    return false;
  }
  const packageSpec =
    replacement.command === "npx"
      ? replacement.args[1]?.slice("--package=".length)
      : replacement.args[1];
  return invocation.packageSpec === packageSpec;
}

function migrationReplacementForContext(
  context: SetupContext,
  invocation: ManualMcpInvocationInspection,
): McpCommand | undefined {
  const replacement = invocation.replacement;
  if (
    !replacement ||
    context.customCommand ||
    !context.runnerExplicit ||
    !isKyosoPackageRunner(context.mcpCommand.command) ||
    context.mcpCommand.command === replacement.command
  ) {
    return replacement;
  }
  const packageSpec = invocation.packageSpec;
  if (
    packageSpec === undefined ||
    (packageSpec !== KYOSO_PACKAGE_NAME &&
      !packageSpec.startsWith(`${KYOSO_PACKAGE_NAME}@`))
  ) {
    return replacement;
  }
  const version =
    packageSpec === KYOSO_PACKAGE_NAME
      ? undefined
      : packageSpec.slice(`${KYOSO_PACKAGE_NAME}@`.length);
  return buildKyosoPackageCommand({
    runner: context.mcpCommand.command,
    ...(version === undefined ? {} : { version }),
    cliArgs: ["mcp"],
  });
}

function isKyosoPackageRunner(value: string): value is KyosoPackageRunner {
  return value === "npx" || value === "bunx";
}

function patchClaudeProjectMcpInvocation(
  content: string,
  replacement: McpCommand,
): string | undefined {
  try {
    JSON.parse(content);
    const root = scanJsonValue(content, skipJsonWhitespace(content, 0));
    if (skipJsonWhitespace(content, root.end) !== content.length)
      return undefined;
    const mcpServers = singleJsonObjectProperty(root, "mcpServers");
    const kyoso = mcpServers && singleJsonObjectProperty(mcpServers, "kyoso");
    const command = kyoso && singleJsonProperty(kyoso, "command");
    const args = kyoso && singleJsonProperty(kyoso, "args");
    if (!command || !args) return undefined;
    return replaceJsonValueSpans(content, [
      { ...command.value, replacement: JSON.stringify(replacement.command) },
      { ...args.value, replacement: JSON.stringify(replacement.args) },
    ]);
  } catch {
    return undefined;
  }
}

type JsonValueNode = {
  kind: "object" | "array" | "scalar";
  start: number;
  end: number;
  entries?: JsonObjectEntry[];
};

type JsonObjectEntry = {
  key: string;
  value: JsonValueNode;
};

function scanJsonValue(content: string, start: number): JsonValueNode {
  const index = skipJsonWhitespace(content, start);
  const character = content[index];
  if (character === "{") return scanJsonObject(content, index);
  if (character === "[") return scanJsonArray(content, index);
  if (character === '"') {
    const end = scanJsonStringEnd(content, index);
    return { kind: "scalar", start: index, end };
  }
  let end = index;
  while (end < content.length && !/[\s,\]}]/.test(content[end] ?? "")) {
    end += 1;
  }
  if (end === index) throw new Error("expected JSON value");
  return { kind: "scalar", start: index, end };
}

function scanJsonObject(content: string, start: number): JsonValueNode {
  let index = skipJsonWhitespace(content, start + 1);
  const entries: JsonObjectEntry[] = [];
  if (content[index] === "}") {
    return { kind: "object", start, end: index + 1, entries };
  }
  for (;;) {
    if (content[index] !== '"') throw new Error("expected JSON object key");
    const keyEnd = scanJsonStringEnd(content, index);
    const key = JSON.parse(content.slice(index, keyEnd)) as unknown;
    if (typeof key !== "string") throw new Error("invalid JSON object key");
    index = skipJsonWhitespace(content, keyEnd);
    if (content[index] !== ":")
      throw new Error("expected JSON object separator");
    const value = scanJsonValue(content, index + 1);
    entries.push({ key, value });
    index = skipJsonWhitespace(content, value.end);
    if (content[index] === "}") {
      return { kind: "object", start, end: index + 1, entries };
    }
    if (content[index] !== ",")
      throw new Error("expected JSON object delimiter");
    index = skipJsonWhitespace(content, index + 1);
  }
}

function scanJsonArray(content: string, start: number): JsonValueNode {
  let index = skipJsonWhitespace(content, start + 1);
  if (content[index] === "]") return { kind: "array", start, end: index + 1 };
  for (;;) {
    const value = scanJsonValue(content, index);
    index = skipJsonWhitespace(content, value.end);
    if (content[index] === "]") return { kind: "array", start, end: index + 1 };
    if (content[index] !== ",")
      throw new Error("expected JSON array delimiter");
    index = skipJsonWhitespace(content, index + 1);
  }
}

function scanJsonStringEnd(content: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < content.length; index += 1) {
    const character = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') return index + 1;
  }
  throw new Error("unterminated JSON string");
}

function skipJsonWhitespace(content: string, start: number): number {
  let index = start;
  while (index < content.length && /\s/.test(content[index] ?? "")) index += 1;
  return index;
}

function singleJsonObjectProperty(
  object: JsonValueNode,
  key: string,
): JsonValueNode | undefined {
  const property = singleJsonProperty(object, key);
  return property?.value.kind === "object" ? property.value : undefined;
}

function singleJsonProperty(
  object: JsonValueNode,
  key: string,
): JsonObjectEntry | undefined {
  if (object.kind !== "object") return undefined;
  const matches = object.entries?.filter((entry) => entry.key === key) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

function replaceJsonValueSpans(
  content: string,
  replacements: Array<JsonValueNode & { replacement: string }>,
): string | undefined {
  const sorted = [...replacements].sort(
    (left, right) => right.start - left.start,
  );
  if (sorted[0]?.start === sorted[1]?.start) return undefined;
  let next = content;
  for (const replacement of sorted) {
    next = `${next.slice(0, replacement.start)}${replacement.replacement}${next.slice(replacement.end)}`;
  }
  return next;
}

type MigrationFileSafety = {
  mode: number;
  dev: number;
  ino: number;
};

async function inspectMigrationFile(
  path: string,
  options: {
    expectedContents?: string;
    expectedSafety?: MigrationFileSafety;
    expectedNlink?: number;
  } = {},
): Promise<
  { ok: true; safety: MigrationFileSafety } | { ok: false; detail: string }
> {
  try {
    const before = await lstat(path);
    if (
      !isSafeMigrationFile(
        before,
        options.expectedSafety,
        options.expectedNlink,
      )
    ) {
      return {
        ok: false,
        detail:
          "The existing config is not an unlinked regular file and was left for manual migration.",
      };
    }
    if (options.expectedContents !== undefined) {
      const contents = await readFile(path, "utf8");
      const after = await lstat(path);
      if (
        !isSafeMigrationFile(
          after,
          options.expectedSafety,
          options.expectedNlink,
        ) ||
        !sameMigrationFileIdentity(before, after) ||
        contents !== options.expectedContents
      ) {
        return {
          ok: false,
          detail:
            "The existing config changed after final migration validation and was left unchanged.",
        };
      }
      return { ok: true, safety: migrationFileSafety(after) };
    }
    return { ok: true, safety: migrationFileSafety(before) };
  } catch (error) {
    return {
      ok: false,
      detail: `The existing config could not be safely inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isSafeMigrationFile(
  metadata: Stats,
  expectedSafety?: MigrationFileSafety,
  expectedNlink = 1,
): boolean {
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== expectedNlink
  ) {
    return false;
  }
  return (
    expectedSafety === undefined ||
    (sameMigrationFileIdentity(metadata, expectedSafety) &&
      (metadata.mode & 0o777) === expectedSafety.mode)
  );
}

function sameMigrationFileIdentity(
  metadata: { dev: number | bigint; ino: number | bigint },
  expected: { dev: number | bigint; ino: number | bigint },
): boolean {
  return metadata.dev === expected.dev && metadata.ino === expected.ino;
}

function migrationFileSafety(metadata: Stats): MigrationFileSafety {
  return {
    mode: metadata.mode & 0o777,
    dev: metadata.dev,
    ino: metadata.ino,
  };
}

class MigrationConflictError extends Error {}

class MigrationCommittedError extends Error {}

function migrationConflictResult(
  title: "Codex MCP" | "Claude Code MCP",
  path: string,
  detail: string,
): StepResult {
  return {
    kind: "mcp",
    registration: "preserved",
    title,
    status: "conflict",
    path,
    detail,
  };
}

async function writeFileAtomically(
  path: string,
  contents: string,
  expectedSafety: MigrationFileSafety,
  expectedContents: string,
  options: {
    beforeCommit?: (path: string) => void | Promise<void>;
    afterExpectedContentsCheck?: (path: string) => void | Promise<void>;
    beforeRename?: (path: string) => void | Promise<void>;
    replace?: (source: string, destination: string) => Promise<void>;
  },
): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.kyoso-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replacementCommitted = false;
  try {
    handle = await open(temporaryPath, "wx", expectedSafety.mode);
    await handle.writeFile(contents, "utf8");
    await chmod(temporaryPath, expectedSafety.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeCommit?.(path);
    await options.afterExpectedContentsCheck?.(path);
    await options.beforeRename?.(path);
    const beforeRename = await inspectMigrationFile(path, {
      expectedContents,
      expectedSafety,
    });
    if (!beforeRename.ok) {
      throw new MigrationConflictError(beforeRename.detail);
    }
    try {
      await (options.replace ?? rename)(temporaryPath, path);
      replacementCommitted = true;
    } catch (error) {
      const installed = await inspectMigrationFile(path, {
        expectedContents: contents,
      });
      if (installed.ok && installed.safety.mode === expectedSafety.mode) {
        throw new MigrationCommittedError(
          "manual MCP migration may have been committed before replacement reported an error",
        );
      }
      throw error;
    }
    await syncDirectory(directory);
    const installed = await inspectMigrationFile(path, {
      expectedContents: contents,
    });
    if (!installed.ok || installed.safety.mode !== expectedSafety.mode) {
      throw new MigrationCommittedError(
        "the replacement config could not be verified after installation",
      );
    }
  } catch (error) {
    if (
      error instanceof MigrationConflictError ||
      error instanceof MigrationCommittedError
    ) {
      throw error;
    }
    if (replacementCommitted) {
      throw new MigrationCommittedError(
        `manual MCP migration may have been committed but could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw new MigrationConflictError(
      `manual MCP migration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (isUnsupportedDirectorySyncError(error)) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    (process.platform === "win32" && code === "EPERM")
  );
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function unsupportedBunxResult(
  context: SetupContext,
  title: "Codex MCP" | "Claude Code MCP",
  path: string,
  command: McpCommand,
  options: { migration?: boolean } = {},
): StepResult | undefined {
  if (
    !context.write ||
    (options.migration && !context.force) ||
    context.customCommand ||
    command.command !== "bunx"
  ) {
    return undefined;
  }
  const probe =
    context.bunxProbe ??
    (context.bunxProbe = context.bunxVersionProbe({
      cwd: context.cwd,
      env: context.env,
    }));
  if (probe.status === "verified") return undefined;
  const fallback = formatBunxFallbackCommand(context, title, options);
  return {
    kind: "mcp",
    registration: "blocked",
    title,
    status: "skipped",
    path,
    detail: `bunx was not verified for explicit package selection (${probe.detail}). No MCP config was written. Use ${fallback}, or install Bun 1.3.14 or newer and retry --runner bunx.`,
  };
}

function requiresExplicitBunxRunnerForMigration(
  context: SetupContext,
  command: McpCommand,
): boolean {
  return command.command === "bunx" && !context.runnerExplicit;
}

function formatBunxFallbackCommand(
  context: SetupContext,
  title: "Codex MCP" | "Claude Code MCP",
  options: { migration?: boolean },
): string {
  const cliArgs = [
    "setup",
    title === "Codex MCP" ? "codex" : "claude-code",
    "--write",
    "--runner",
    "npx",
  ];
  if (context.scope === "global") cliArgs.push("--global");
  if (context.withOpenRouter) cliArgs.push("--with-openrouter");
  if (options.migration) cliArgs.push("--force");
  return formatKyosoPackageCommand({ runner: "npx", cliArgs });
}

function bunxVerificationPendingDetail(
  context: SetupContext,
  command: McpCommand,
): string {
  if (context.customCommand || command.command !== "bunx") return "";
  if (!context.runnerExplicit) {
    return "\nLegacy Bun registration will stay unchanged unless you rerun with --write --runner bunx --force to verify and migrate it, or with --runner npx --force to migrate it using npx.";
  }
  return "\nBun 1.3.14 or newer will be verified before any MCP config is written.";
}

function formatMigrationPreviewValue(value: string): string {
  return JSON.stringify(sanitizeTextForDisplay(value));
}

function formatMigrationPreviewArgs(args: readonly string[]): string {
  return `[${args.map(formatMigrationPreviewValue).join(", ")}]`;
}

export function probeBunxVersion(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): BunxVersionProbeResult {
  const probeDirectory = mkdtempSync(join(tmpdir(), "kyoso-bunx-probe-"));
  try {
    const result = spawnSync("bunx", ["--version"], {
      cwd: probeDirectory,
      env: sanitizedBunxProbeEnv(options.env, probeDirectory),
      encoding: "utf8",
      timeout: 2_000,
      shell: false,
    });
    const errorCode =
      result.error && "code" in result.error
        ? (result.error as { code?: unknown }).code
        : undefined;
    if (errorCode === "ENOENT") {
      return { status: "missing", detail: "bunx was not found on PATH" };
    }
    if (errorCode === "ETIMEDOUT" || result.signal) {
      return { status: "timeout", detail: "bunx --version timed out" };
    }
    if (result.status !== 0) {
      return {
        status: "failed",
        detail: `bunx --version exited ${result.status ?? "without a status"}`,
      };
    }
    const version = result.stdout.trim();
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      return {
        status: "invalid",
        detail: "bunx --version did not return a stable SemVer",
      };
    }
    if (!isCompleteSemVer(version) || !isMinimumBunVersion(version, "1.3.14")) {
      return {
        status: "unsupported",
        detail: `bunx ${version} is older than the verified minimum 1.3.14`,
      };
    }
    return { status: "verified", version };
  } finally {
    rmSync(probeDirectory, { force: true, recursive: true });
  }
}

function sanitizedBunxProbeEnv(
  env: NodeJS.ProcessEnv,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "",
    HOME: env.HOME ?? "",
    TMPDIR: temporaryDirectory,
  };
  for (const key of ["SystemRoot", "ComSpec", "PATHEXT", "WINDIR"] as const) {
    if (env[key]) result[key] = env[key];
  }
  return result;
}

function isMinimumBunVersion(version: string, minimum: string): boolean {
  const actualParts = version.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < minimumParts.length; index += 1) {
    const actual = actualParts[index] ?? 0;
    const required = minimumParts[index] ?? 0;
    if (actual > required) return true;
    if (actual < required) return false;
  }
  return true;
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
  registrations: ManualMcpRegistration[];
};

function detectCodexMcp(path: string, cwd: string, home: string): McpDetection {
  if (!existsSync(path)) return missingMcpDetection();

  try {
    const parsed = parse(readTextSync(path));
    if (hasUnprobedProjectIntegrationOverride(parsed, cwd, home)) {
      return singleMcpDetection(
        manualMcpRegistration({
          path,
          scope: "codex-global",
          status: "unknown",
          value: undefined,
        }),
      );
    }
    if (!isRecord(parsed)) {
      return singleMcpDetection(
        manualMcpRegistration({
          path,
          scope: "codex-global",
          status: "unknown",
          value: undefined,
        }),
      );
    }
    if (!("mcp_servers" in parsed)) return missingMcpDetection();
    if (!isRecord(parsed.mcp_servers)) {
      return singleMcpDetection(
        manualMcpRegistration({
          path,
          scope: "codex-global",
          status: "unknown",
          value: undefined,
        }),
      );
    }
    if (!("kyoso" in parsed.mcp_servers)) {
      return missingMcpDetection();
    }
    return singleMcpDetection(
      manualMcpRegistration({
        path,
        scope: "codex-global",
        status: mcpEntryStatus(parsed.mcp_servers.kyoso),
        value: parsed.mcp_servers.kyoso,
      }),
    );
  } catch {
    return singleMcpDetection(
      manualMcpRegistration({
        path,
        scope: "codex-global",
        status: "unknown",
        value: undefined,
      }),
    );
  }
}

function detectClaudeMcp(
  path: string,
  cwd: string,
  home: string,
): McpDetection {
  if (!existsSync(path)) return missingMcpDetection();

  try {
    const parsed: unknown = JSON.parse(readTextSync(path));
    const registrations = jsonMcpRegistrations(parsed, path, cwd, home);
    return registrations.length === 0
      ? missingMcpDetection()
      : mergeMcpDetections([
          {
            status: mergeMcpStatuses(
              registrations.map((entry) => entry.status),
            ),
            paths: [path],
            registrations,
          },
        ]);
  } catch {
    return singleMcpDetection(
      manualMcpRegistration({
        path,
        scope: path.endsWith(".mcp.json") ? "claude-project" : "claude-global",
        status: "unknown",
        value: undefined,
      }),
    );
  }
}

function jsonMcpRegistrations(
  value: unknown,
  path: string,
  cwd: string,
  home: string,
): ManualMcpRegistration[] {
  const directScope: ManualMcpScope = path.endsWith(".mcp.json")
    ? "claude-project"
    : "claude-global";
  if (!isRecord(value)) {
    return [
      manualMcpRegistration({
        path,
        scope: directScope,
        status: "unknown",
        value: undefined,
      }),
    ];
  }

  const registrations = directMcpRegistrations(value, path, directScope);
  if (!("projects" in value)) return registrations;
  if (!isRecord(value.projects)) {
    return [
      ...registrations,
      manualMcpRegistration({
        path,
        scope: "claude-global-project",
        status: "unknown",
        value: undefined,
      }),
    ];
  }

  const currentProject = normalizeProjectPath(cwd, home);
  for (const [projectPath, projectConfig] of Object.entries(value.projects)) {
    if (normalizeProjectPath(projectPath, home) !== currentProject) continue;
    if (!isRecord(projectConfig)) {
      registrations.push(
        manualMcpRegistration({
          path,
          scope: "claude-global-project",
          status: "unknown",
          value: undefined,
        }),
      );
      continue;
    }
    registrations.push(
      ...directMcpRegistrations(projectConfig, path, "claude-global-project"),
    );
  }
  return registrations;
}

function directMcpRegistrations(
  value: Record<string, unknown>,
  path: string,
  scope: ManualMcpScope,
): ManualMcpRegistration[] {
  if (!("mcpServers" in value)) return [];
  if (!isRecord(value.mcpServers)) {
    return [
      manualMcpRegistration({
        path,
        scope,
        status: "unknown",
        value: undefined,
      }),
    ];
  }
  if (!("kyoso" in value.mcpServers)) return [];
  return [
    manualMcpRegistration({
      path,
      scope,
      status: mcpEntryStatus(value.mcpServers.kyoso),
      value: value.mcpServers.kyoso,
    }),
  ];
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
  const registrations = detections.flatMap(
    (detection) => detection.registrations,
  );
  if (registrations.length === 0) return missingMcpDetection();
  return {
    status:
      registrations.length === 1
        ? (registrations[0]?.status ?? "unknown")
        : "unknown",
    paths: [...new Set(registrations.map((registration) => registration.path))],
    registrations,
  };
}

function missingMcpDetection(): McpDetection {
  return { status: "missing", paths: [], registrations: [] };
}

function singleMcpDetection(registration: ManualMcpRegistration): McpDetection {
  return {
    status: registration.status,
    paths: [registration.path],
    registrations: [registration],
  };
}

function isCurrentManualMcp(detection: McpDetection): boolean {
  return (
    detection.status === "enabled" &&
    detection.registrations.length === 1 &&
    detection.registrations[0]?.invocation.kind === "current"
  );
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
