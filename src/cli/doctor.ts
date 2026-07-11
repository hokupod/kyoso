import { accessSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { inspectAuditStateRootCapability } from "../audit/stateRoot.js";
import {
  loadConfig,
  resolveGlobalTomlConfigPath,
} from "../config/loadConfig.js";
import { resolveJudgeProvider } from "../judge/provider.js";
import {
  formatCodexInspectionFailure,
  inspectCodexMcpList,
  inspectCodexPlugin,
  type CodexMcpListInspection,
  type CodexPluginInspection,
  type CodexPluginInspectionOptions,
} from "./codexPluginDetector.js";
import {
  detectCli,
  determineNonPluginIntegration,
  formatCliAvailability,
  type CliDetection,
  type IntegrationMode,
} from "./integration.js";
import {
  detectCodexPluginMcpOverride,
  detectSetup,
  type ManualMcpStatus,
  type SetupDetection,
} from "./setup.js";

export async function runDoctor(options: {
  cwd: string;
  configPath?: string;
  ignoreConfig?: boolean;
  trustConfig?: boolean;
  allowUnknownConfig?: boolean;
  promptForTrust?: boolean;
  trustStorePath?: string;
  env?: NodeJS.ProcessEnv;
  pluginInspector?: (
    options: CodexPluginInspectionOptions,
  ) => CodexPluginInspection;
  mcpListInspector?: (
    options: CodexPluginInspectionOptions,
  ) => CodexMcpListInspection;
}): Promise<string> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig(options);
  const globalConfigPath = resolveGlobalTomlConfigPath(env);
  const projectTomlPath = resolve(options.cwd, "kyoso.toml");
  const projectTsPath = resolve(options.cwd, "kyoso.config.ts");
  const lines: string[] = ["Kyoso doctor", "", "Runtime"];
  lines.push(
    `  Bun: ${commandExists("bun", env) ? "ok" : "warning not found"}`,
  );
  lines.push(
    `  Node/npm: ${commandExists("npm", env) ? "ok" : "warning npm not found"}`,
  );

  lines.push("", "Config");
  lines.push(
    `  global config.toml: ${formatLayer(loaded, "global_toml", globalConfigPath)}`,
  );
  lines.push(
    `  kyoso.toml: ${formatLayer(loaded, "project_toml", projectTomlPath)}`,
  );
  lines.push(
    `  kyoso.config.ts: ${formatProjectTsLayer(loaded, projectTsPath)}`,
  );
  lines.push(
    `  trusted config: ${formatTrustStatus(loaded.configTrustStatus)}`,
  );
  if (loaded.configHash) lines.push(`  config hash: ${loaded.configHash}`);
  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);

  const setup = detectSetup({ cwd: options.cwd, env });
  const cli = detectCli({ cwd: options.cwd, env });
  const codexIntegration = determineCodexIntegration({
    cwd: options.cwd,
    env,
    setup: setup.codex,
    cli,
    pluginInspector: options.pluginInspector ?? inspectCodexPlugin,
    mcpListInspector: options.mcpListInspector ?? inspectCodexMcpList,
  });
  const claudeIntegration = determineClientIntegration(
    "claude-code",
    setup["claude-code"],
    cli,
  );

  lines.push("", "MCP", "  stdio server: ok");
  lines.push(
    `  Codex registration: ${formatManualMcpStatus(setup.codex.manualMcpStatus)}`,
  );
  lines.push(
    `  Claude Code registration: ${formatManualMcpStatus(setup["claude-code"].manualMcpStatus)}`,
  );

  lines.push("", "Skills");
  lines.push(`  Codex kyoso-review: ${setup.codex.skill ? "ok" : "missing"}`);
  lines.push(
    `  Claude Code kyoso-review: ${setup["claude-code"].skill ? "ok" : "missing"}`,
  );
  lines.push("", "Integration");
  appendIntegration(lines, codexIntegration);
  appendIntegration(lines, claudeIntegration);

  lines.push("", "ACP agents");
  const agentCommandExists = {
    codex: commandExists(loaded.config.agents.codex.command, env),
    claude: commandExists(loaded.config.agents.claude.command, env),
  };
  for (const agent of ["codex", "claude"] as const) {
    const config = loaded.config.agents[agent];
    const exists = agentCommandExists[agent];
    lines.push(
      `  ${agent === "codex" ? "Codex" : "Claude"}: ${exists ? "ok" : "warning command not found"}`,
    );
    lines.push(`    command: ${[config.command, ...config.args].join(" ")}`);
    if (!exists && config.command === "npx" && commandExists("bunx", env)) {
      lines.push('    hint: set agents.<name>.command = "bunx" in config.toml');
    }
    if (agent === "claude") {
      const hasApiKey = hasEnv(env, "ANTHROPIC_API_KEY");
      const hasOAuthToken = hasEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
      if (!hasApiKey && !hasOAuthToken) {
        lines.push(
          "    auth: set ANTHROPIC_API_KEY (API billing) or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (subscription)",
        );
      } else if (hasApiKey && hasOAuthToken) {
        lines.push("    auth: detected");
        lines.push(formatClaudeDualAuthWarning(config.auth.preferApiKey));
      } else if (hasOAuthToken) {
        lines.push("    auth: detected Claude Code OAuth token");
      } else {
        lines.push("    auth: detected Anthropic API key");
      }
    } else {
      lines.push("    auth: detected or delegated");
    }
  }
  if (agentCommandExists.codex !== agentCommandExists.claude) {
    const missing = agentCommandExists.codex ? "claude" : "codex";
    const remaining = agentCommandExists.codex ? "codex" : "claude";
    lines.push(
      `  single-agent mode: set agents.${missing}.enabled: false to use ${remaining} only; the remaining agent will cover both review roles.`,
    );
  }

  const judgeProvider =
    loaded.config.judge.mode === "deterministic_only"
      ? "deterministic_fallback"
      : resolveJudgeProvider(loaded.config.judge.provider, env);
  lines.push("", "Judge");
  lines.push(`  provider: ${judgeProvider}`);
  lines.push(
    judgeProvider === "deterministic_fallback"
      ? "  billing: none (deterministic fallback)"
      : "  billing: direct provider API calls (pay-per-token billing)",
  );

  lines.push("", "Security");
  lines.push("  secret scan: enabled");
  lines.push(
    `  blockOnDetectedSecret: ${loaded.config.secrets.blockOnDetectedSecret}`,
  );
  lines.push(`  network default: ${loaded.config.network.defaultMode}`);

  lines.push("", "Audit");
  lines.push(`  directory: ${loaded.config.audit.directory}`);
  const auditStateRoot = await inspectAuditStateRootCapability({
    cwd: options.cwd,
    env,
  });
  lines.push(
    `  state root: ${auditStateRoot.available ? "available" : "unavailable"}`,
  );
  lines.push(
    `  raw agent output: ${loaded.config.audit.includeRawAgentOutput ? "enabled" : "disabled"}`,
  );

  return lines.join("\n");
}

type DoctorIntegrationMode = IntegrationMode | "plugin-mcp" | "plugin-skill";

type DoctorIntegration = {
  client: "Codex" | "Claude Code";
  commandClient: "codex" | "claude-code";
  mode: DoctorIntegrationMode;
  setup: SetupDetection;
  cli: CliDetection;
  warnings: string[];
  advice: string;
  plugin?: string;
  pluginMcp?: string;
};

function determineCodexIntegration(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  setup: SetupDetection;
  cli: CliDetection;
  pluginInspector: (
    options: CodexPluginInspectionOptions,
  ) => CodexPluginInspection;
  mcpListInspector: (
    options: CodexPluginInspectionOptions,
  ) => CodexMcpListInspection;
}): DoctorIntegration {
  const fallback = determineClientIntegration(
    "codex",
    options.setup,
    options.cli,
  );
  const plugin = options.pluginInspector({
    cwd: options.cwd,
    env: options.env,
  });
  if (plugin.status === "unsupported") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          `Plugin detection unsupported: ${formatCodexInspectionFailure(plugin.failure)}`,
        ],
        undefined,
        "not applicable",
      ),
      "unsupported",
      "not applicable",
    );
  }

  if (plugin.plugin.state === "not_installed") {
    return withPluginDetails(fallback, "not installed", "not applicable");
  }
  if (plugin.plugin.state === "disabled") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        ["Plugin disabled."],
        undefined,
        undefined,
      ),
      "installed, disabled",
      "disabled with Plugin",
    );
  }

  const pluginWarnings = pluginSkillWarnings(options.setup);
  const override = detectCodexPluginMcpOverride({
    cwd: options.cwd,
    env: options.env,
  });
  if (options.setup.manualMcpStatus === "unknown") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          ...pluginWarnings,
          "Plugin MCP origin is unknown because the manual MCP configuration could not be classified.",
        ],
        "unknown",
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  if (
    options.setup.manualMcpStatus === "enabled" &&
    override.status !== "disabled"
  ) {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "manual-mcp",
          advice: integrationAdvice("manual-mcp", "codex"),
        },
        [
          ...pluginWarnings,
          "Plugin and manual Codex MCP registrations coexist; neither registration was changed.",
          "Plugin MCP origin is unknown while a manual MCP registration is enabled.",
        ],
        undefined,
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  if (override.status === "unknown") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          ...pluginWarnings,
          "Plugin MCP override could not be safely classified from the Codex configuration.",
        ],
        "unknown",
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  if (
    override.status === "disabled" &&
    options.setup.manualMcpStatus === "enabled"
  ) {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "manual-mcp",
          advice: integrationAdvice("manual-mcp", "codex"),
        },
        [
          ...pluginWarnings,
          "Plugin and manual Codex MCP registrations coexist; neither registration was changed.",
          "Plugin MCP is disabled by configuration override while the manual MCP remains enabled.",
        ],
        undefined,
        "disabled by configuration override",
      ),
      "installed, enabled",
      "disabled by configuration override",
    );
  }

  if (
    override.status === "disabled" &&
    options.setup.manualMcpStatus === "disabled"
  ) {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "plugin-skill",
          advice: integrationAdvice("plugin-skill", "codex"),
        },
        pluginWarnings,
        undefined,
        "disabled by configuration override",
      ),
      "installed, enabled",
      "disabled by configuration override",
    );
  }

  if (options.setup.manualMcpStatus === "disabled") {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "plugin-mcp",
          advice: integrationAdvice("plugin-mcp", "codex"),
        },
        pluginWarnings,
        undefined,
        "enabled (manual registration is disabled)",
      ),
      "installed, enabled",
      "enabled (manual registration is disabled)",
    );
  }

  const effectiveMcp = options.mcpListInspector({
    cwd: options.cwd,
    env: options.env,
  });
  if (effectiveMcp.status === "unsupported") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          ...pluginWarnings,
          `Plugin MCP effective-state check unsupported: ${formatCodexInspectionFailure(effectiveMcp.failure)}`,
        ],
        "unknown",
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  const expectedEffectiveState =
    override.status === "disabled" ? "disabled" : "enabled";
  if (
    effectiveMcp.kyoso === "enabled" &&
    expectedEffectiveState === "enabled"
  ) {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "plugin-mcp",
          advice: integrationAdvice("plugin-mcp", "codex"),
        },
        pluginWarnings,
        undefined,
        "enabled",
      ),
      "installed, enabled",
      "enabled",
    );
  }
  if (
    effectiveMcp.kyoso === "disabled" &&
    expectedEffectiveState === "disabled"
  ) {
    return withPluginDetails(
      withIntegrationWarnings(
        {
          ...fallback,
          mode: "plugin-skill",
          advice: integrationAdvice("plugin-skill", "codex"),
        },
        pluginWarnings,
        undefined,
        "disabled",
      ),
      "installed, enabled",
      "disabled",
    );
  }
  if (effectiveMcp.kyoso === "enabled" || effectiveMcp.kyoso === "disabled") {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          ...pluginWarnings,
          "Plugin MCP effective state does not match the recorded configuration precedence; Plugin MCP mode was not inferred.",
        ],
        "unknown",
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  return withPluginDetails(
    withIntegrationWarnings(
      fallback,
      [
        ...pluginWarnings,
        "Plugin MCP effective state is unknown; Plugin MCP mode was not inferred.",
      ],
      "unknown",
      "unknown",
    ),
    "installed, enabled",
    "unknown",
  );
}

function determineClientIntegration(
  client: "codex" | "claude-code",
  setup: SetupDetection,
  cli: CliDetection,
): DoctorIntegration {
  const integration = determineNonPluginIntegration({
    manualMcpStatus: setup.manualMcpStatus,
    hasSkill: setup.skill,
    cli,
  });
  return {
    client: client === "codex" ? "Codex" : "Claude Code",
    commandClient: client,
    mode: integration.mode,
    setup,
    cli,
    warnings: integration.warnings,
    advice: integrationAdvice(integration.mode, client),
  };
}

function withPluginDetails(
  integration: DoctorIntegration,
  plugin: string,
  pluginMcp: string,
): DoctorIntegration {
  return { ...integration, plugin, pluginMcp };
}

function withIntegrationWarnings(
  integration: DoctorIntegration,
  warnings: string[],
  mode: DoctorIntegrationMode | undefined,
  pluginMcp: string | undefined,
): DoctorIntegration {
  const nextMode = mode ?? integration.mode;
  return {
    ...integration,
    mode: nextMode,
    warnings: [...integration.warnings, ...warnings],
    advice: integrationAdvice(nextMode, integration.commandClient),
    ...(pluginMcp ? { pluginMcp } : {}),
  };
}

function pluginSkillWarnings(setup: SetupDetection): string[] {
  if (!setup.skill) return [];
  return [
    `Plugin Skill and manual Skill copy coexist; priority is not inferred. Manual Skill path(s): ${setup.skillPaths.join(", ")}`,
  ];
}

function appendIntegration(
  lines: string[],
  integration: DoctorIntegration,
): void {
  lines.push(`  ${integration.client} integration: ${integration.mode}`);
  lines.push(
    `    manual MCP: ${formatManualMcpStatus(integration.setup.manualMcpStatus)}`,
  );
  if (integration.setup.mcpPaths.length > 0) {
    lines.push(
      `    manual MCP path(s): ${integration.setup.mcpPaths.join(", ")}`,
    );
  }
  lines.push(`    Skill: ${integration.setup.skill ? "ok" : "missing"}`);
  if (integration.setup.skillPaths.length > 0) {
    lines.push(
      `    manual Skill path(s): ${integration.setup.skillPaths.join(", ")}`,
    );
  }
  lines.push(`    CLI: ${formatCliAvailability(integration.cli.kyoso)}`);
  lines.push(`    npx: ${integration.cli.npx ? "available" : "missing"}`);
  lines.push(`    bunx: ${integration.cli.bunx ? "available" : "missing"}`);
  if (integration.plugin) lines.push(`    Plugin: ${integration.plugin}`);
  if (integration.pluginMcp) {
    lines.push(`    Plugin MCP: ${integration.pluginMcp}`);
  }
  for (const warning of integration.warnings) {
    lines.push(`    warning: ${warning}`);
  }
  lines.push(`    ${integration.advice}`);
}

function formatManualMcpStatus(status: ManualMcpStatus): string {
  if (status === "enabled") return "ok";
  return status;
}

function integrationAdvice(
  mode: DoctorIntegrationMode,
  client: "codex" | "claude-code",
): string {
  if (mode === "plugin-mcp" || mode === "manual-mcp") {
    return "status: ready";
  }
  if (mode === "plugin-skill") {
    return "status: bundled Plugin MCP is disabled; re-enable it or remove the Plugin and use CLI plus Skill-only.";
  }
  if (mode === "cli-skill") {
    return "status: ready; MCP is optional for CLI plus Skill mode.";
  }
  if (mode === "skill-on-demand") {
    return "status: runnable on demand; package-runner fallback may need network access.";
  }
  if (mode === "mcp-only") {
    return `next: run \`npx @kyo-so/cli setup ${client} --write --skill-only\``;
  }
  if (mode === "cli-only") {
    return `next: run \`kyoso setup ${client} --write --skill-only\``;
  }
  if (mode === "missing") {
    return "next: choose a Marketplace Plugin, CLI plus Skill, or traditional MCP setup.";
  }
  return "status: inspect the warnings before changing integration state.";
}

function formatLayer(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  layer: "global_toml" | "project_toml",
  defaultPath: string,
): string {
  const source = loaded.sources.find((candidate) => candidate.layer === layer);
  return source ? `found ${source.path}` : `not found ${defaultPath}`;
}

function formatProjectTsLayer(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  defaultPath: string,
): string {
  const source = loaded.sources.find(
    (candidate) => candidate.layer === "project_ts",
  );
  if (source) return `found ${source.path} (deprecated)`;
  if (loaded.warnings.some((warning) => warning.includes("was ignored"))) {
    return `ignored ${defaultPath} (kyoso.toml takes precedence)`;
  }
  return `not found ${defaultPath}`;
}

function formatTrustStatus(status: string): string {
  if (status === "trusted_by_flag") return "trusted by --trust-config";
  if (status === "trusted_interactively") return "trusted interactively";
  if (status === "untrusted_skipped") return "untrusted; skipped";
  if (status === "not_found") return "not found";
  return status;
}

function formatClaudeDualAuthWarning(preferApiKey: boolean): string {
  if (preferApiKey) {
    return "    auth policy: Kyoso forwards only ANTHROPIC_API_KEY because agents.claude.auth.preferApiKey is true";
  }
  return "    auth policy: Kyoso forwards only CLAUDE_CODE_OAUTH_TOKEN; set agents.claude.auth.preferApiKey to true to use ANTHROPIC_API_KEY";
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const paths = env.PATH?.split(delimiter) ?? [];
  return paths.some((path) => {
    try {
      accessSync(`${path}/${command}`);
      return true;
    } catch {
      return false;
    }
  });
}
