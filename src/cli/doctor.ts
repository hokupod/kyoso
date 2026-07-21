import { accessSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { z } from "zod";
import { inspectAuditStateRootCapability } from "../audit/stateRoot.js";
import {
  getConfigValidationContext,
  loadConfig,
  ProjectOpenRouterAuthorizationError,
  resolveGlobalTomlConfigPath,
} from "../config/loadConfig.js";
import {
  CODEX_OPENROUTER_MODEL_REQUIRED_ISSUE,
  CODEX_OPENROUTER_PROVIDER,
  type KyosoConfig,
} from "../config/schema.js";
import { resolveJudgeCallRoute } from "../judge/provider.js";
import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import {
  hasUsableEnvValue,
  isUnexpandedEnvPlaceholder,
  OPENROUTER_API_KEY_ENV,
} from "../utils/env.js";
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
  formatRunnerAvailability,
  type CliDetection,
  type IntegrationMode,
} from "./integration.js";
import { formatKyosoPackageCommand } from "./packageRunner.js";
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
  const { loaded, configValidationFallback } = await loadDoctorConfig(options);
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
  if (configValidationFallback) {
    lines.push(
      formatFallbackConfigLayer(
        "global config.toml",
        "global_toml",
        globalConfigPath,
        configValidationFallback,
      ),
    );
    lines.push(
      formatFallbackConfigLayer(
        "kyoso.toml",
        "project_toml",
        projectTomlPath,
        configValidationFallback,
      ),
    );
    lines.push(
      formatFallbackConfigLayer(
        "kyoso.config.ts",
        "project_ts",
        projectTsPath,
        configValidationFallback,
      ),
    );
    lines.push(formatFallbackTrustedConfigStatus(configValidationFallback));
  } else {
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
  }

  lines.push("", "Review policy");
  lines.push(
    `  CLI entrypoint: ${loaded.config.entrypoints.cli ? "enabled" : "disabled"}`,
    `  MCP entrypoint: ${loaded.config.entrypoints.mcp ? "enabled" : "disabled"}`,
    `  plan_review: ${loaded.config.tools.planReview ? "enabled" : "disabled"}`,
    `  security_review: ${loaded.config.tools.securityReview ? "enabled" : "disabled"}`,
    `  diff_review: ${loaded.config.tools.diffReview ? "enabled" : "disabled"}`,
    `  additional lenses: ${loaded.config.reviewPolicy.additionalLenses.join(", ") || "none"}`,
    `  independent multi-agent required: ${loaded.config.reviewPolicy.multiAgentRequired}`,
    `  first-class client: ${loaded.config.firstClassClient} (metadata only)`,
    `  mediated web: ${loaded.config.network.mediatedWeb.enabled ? "enabled" : "reserved, disabled"}`,
    `  audit file contents: ${loaded.config.audit.includeFileContents ? "enabled" : "reserved, disabled"}`,
    `  verification severity demotion: disabled (allowDemotion=${loaded.config.verification.allowDemotion} is reserved and has no effect)`,
  );
  if (loaded.configHash) lines.push(`  config hash: ${loaded.configHash}`);
  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);
  if (configValidationFallback) {
    lines.push(`  warning: ${configValidationFallback.warning}`);
    lines.push(`  hint: ${configValidationFallback.hint}`);
  }

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
    `  Codex registration: ${formatManualMcpStatus(setup.codex, cli)}`,
  );
  lines.push(
    `  Claude Code registration: ${formatManualMcpStatus(setup["claude-code"], cli)}`,
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
  if (configValidationFallback) {
    lines.push(
      "  note: user-global config is not reflected; all agent diagnostics below use safe defaults.",
    );
  }
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
    if (
      !configValidationFallback &&
      !exists &&
      config.command === "npx" &&
      commandExists("bunx", env)
    ) {
      lines.push('    hint: set agents.<name>.command = "bunx" in config.toml');
    }
    if (
      agent === "codex" &&
      loaded.config.agents.codex.provider === CODEX_OPENROUTER_PROVIDER
    ) {
      lines.push(`    provider: ${CODEX_OPENROUTER_PROVIDER}`);
      lines.push(
        `    model: ${sanitizeTextForDisplay(loaded.config.agents.codex.model ?? "")}`,
      );
      const openRouter = loaded.config.agents.codex.openRouter;
      lines.push("    reliability:");
      lines.push(
        openRouter.streamIdleTimeoutMs === undefined
          ? "      stream idle timeout: inherited from Codex runtime"
          : `      stream idle timeout: ${openRouter.streamIdleTimeoutMs} ms (Kyoso config)`,
      );
      lines.push(
        openRouter.streamMaxRetries === undefined
          ? "      stream retries: inherited from Codex runtime"
          : `      stream retries: ${openRouter.streamMaxRetries}`,
      );
      lines.push(
        openRouter.requestMaxRetries === undefined
          ? "      request retries: inherited from Codex runtime"
          : `      request retries: ${openRouter.requestMaxRetries}`,
      );
      if (
        openRouter.streamIdleTimeoutMs !== undefined &&
        openRouter.streamMaxRetries !== undefined
      ) {
        const idleOnlyWindow =
          openRouter.streamIdleTimeoutMs * (openRouter.streamMaxRetries + 1);
        lines.push(
          `      maximum idle-only stream window: approximately ${idleOnlyWindow} ms plus backoff`,
        );
        if (idleOnlyWindow >= config.timeoutMs) {
          lines.push(
            `      warning: configured idle-only retry window can consume the entire Codex agent timeout (timeoutMs=${config.timeoutMs}).`,
          );
        }
      }
      const configuredKey =
        loaded.config.agents.codex.env[OPENROUTER_API_KEY_ENV];
      if (
        hasUsableEnvValue(
          loaded.config.agents.codex.env,
          OPENROUTER_API_KEY_ENV,
        )
      ) {
        lines.push(
          `    auth: detected ${OPENROUTER_API_KEY_ENV} from agents.codex.env`,
        );
      } else if (hasUsableEnvValue(env, OPENROUTER_API_KEY_ENV)) {
        lines.push(`    auth: detected ${OPENROUTER_API_KEY_ENV}`);
      } else if (
        isUnexpandedEnvPlaceholder(configuredKey) ||
        isUnexpandedEnvPlaceholder(env[OPENROUTER_API_KEY_ENV])
      ) {
        lines.push(
          `    warning: ${OPENROUTER_API_KEY_ENV} placeholder was not expanded by the client`,
        );
        lines.push(
          `    hint: expand ${OPENROUTER_API_KEY_ENV} in the MCP registration, restart the client, then run \`kyoso doctor\``,
        );
      } else {
        lines.push(
          `    warning: ${OPENROUTER_API_KEY_ENV} is not visible to the Kyoso process`,
        );
        lines.push(
          `    hint: add ${OPENROUTER_API_KEY_ENV} to the MCP registration, restart the client, then run \`kyoso doctor\``,
        );
      }
    } else if (agent === "claude") {
      const hasApiKey = hasUsableEnvValue(env, "ANTHROPIC_API_KEY");
      const hasOAuthToken = hasUsableEnvValue(env, "CLAUDE_CODE_OAUTH_TOKEN");
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

  const judgeRoute = resolveJudgeCallRoute(
    loaded.config.judge.mode,
    loaded.config.judge.provider,
    env,
  );
  const reviewTiming = calculateReviewTiming(
    loaded.config,
    judgeRoute.llmAvailable,
  );
  lines.push("", "Review timing");
  lines.push(
    `  review-wide deadline: ${loaded.config.reviewBudget.maxTotalWallTimeMs} ms`,
    `  sequential phases: primary ${reviewTiming.primaryPhaseMs} + verification ${reviewTiming.verificationPhaseMs} + LLM judge ${reviewTiming.judgePhaseMs} = ${reviewTiming.sequentialPhaseMs} ms`,
    `  recommended review-wide deadline: ${reviewTiming.recommendedReviewWallTimeMs} ms`,
  );
  if (
    loaded.config.reviewBudget.maxTotalWallTimeMs <
    reviewTiming.sequentialPhaseMs
  ) {
    lines.push(
      `  warning: review-wide deadline is insufficient: ${loaded.config.reviewBudget.maxTotalWallTimeMs} ms is below the configured sequential phase time of ${reviewTiming.sequentialPhaseMs} ms; later phases cannot receive their configured timeout.`,
      `  hint: set user-global reviewBudget.maxTotalWallTimeMs to at least ${reviewTiming.recommendedReviewWallTimeMs}.`,
    );
  } else if (
    loaded.config.reviewBudget.maxTotalWallTimeMs <
    reviewTiming.recommendedReviewWallTimeMs
  ) {
    lines.push(
      `  warning: review-wide deadline has low margin: ${loaded.config.reviewBudget.maxTotalWallTimeMs} ms is below the recommended ${reviewTiming.recommendedReviewWallTimeMs} ms; scheduling and finalization margin is reduced.`,
      `  hint: set user-global reviewBudget.maxTotalWallTimeMs to at least ${reviewTiming.recommendedReviewWallTimeMs}.`,
    );
  }

  const judgeProvider = judgeRoute.llmAvailable
    ? judgeRoute.provider
    : "deterministic_fallback";
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
  const cisaPolicy = loaded.config.securityReview.cisaSecureByDesign;
  lines.push(
    `  CISA enabled: ${cisaPolicy.enabled}`,
    `  CISA gate: ${cisaPolicy.gate}`,
    `  CISA dimensions: ${
      Object.entries(cisaPolicy.dimensions)
        .filter(([, enabled]) => enabled)
        .map(([dimension]) => dimension)
        .join(", ") || "none"
    }`,
  );

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

function calculateReviewTiming(
  config: KyosoConfig,
  llmJudgeAvailable: boolean,
): {
  primaryPhaseMs: number;
  verificationPhaseMs: number;
  judgePhaseMs: number;
  sequentialPhaseMs: number;
  recommendedReviewWallTimeMs: number;
} {
  const primaryPhaseMs = Math.max(
    0,
    ...Object.values(config.agents)
      .filter((agent) => agent.enabled)
      .map((agent) => agent.timeoutMs),
  );
  const verificationPhaseMs = config.verification.enabled
    ? config.verification.timeoutMs
    : 0;
  const judgePhaseMs = llmJudgeAvailable ? config.judge.timeoutMs : 0;
  const sequentialPhaseMs = primaryPhaseMs + verificationPhaseMs + judgePhaseMs;
  const recommendedReviewWallTimeMs =
    sequentialPhaseMs + Math.max(60_000, Math.ceil(sequentialPhaseMs * 0.1));

  return {
    primaryPhaseMs,
    verificationPhaseMs,
    judgePhaseMs,
    sequentialPhaseMs,
    recommendedReviewWallTimeMs,
  };
}

type DoctorIntegrationMode = IntegrationMode | "plugin-mcp" | "plugin-skill";

async function loadDoctorConfig(
  options: NonNullable<Parameters<typeof loadConfig>[0]>,
): Promise<{
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  configValidationFallback?: DoctorConfigValidationFallback;
}> {
  try {
    return { loaded: await loadConfig(options) };
  } catch (error) {
    const configValidationFallback = doctorConfigValidationFallback(error);
    if (!configValidationFallback) throw error;

    return {
      loaded: await loadConfig({
        cwd: options.cwd,
        env: options.env,
        ignoreConfig: true,
      }),
      configValidationFallback,
    };
  }
}

type DoctorConfigValidationFallback = {
  warning: string;
  hint: string;
  affectedLayer?: "global_toml" | "project_toml" | "project_ts";
  affectedPath?: string;
  trustedConfigExecution?: "authorization" | "validation";
};

function formatFallbackTrustedConfigStatus(
  fallback: DoctorConfigValidationFallback,
): string {
  if (fallback.trustedConfigExecution === "authorization") {
    return "  trusted config: executed but not applied after authorization failure";
  }
  if (fallback.trustedConfigExecution === "validation") {
    return "  trusted config: executed but not applied after validation failure";
  }
  return "  trusted config: not evaluated after validation failure";
}

function formatFallbackConfigLayer(
  label: string,
  layer: NonNullable<DoctorConfigValidationFallback["affectedLayer"]>,
  path: string,
  fallback: DoctorConfigValidationFallback,
): string {
  if (!fallback.affectedLayer || fallback.affectedLayer !== layer) {
    return `  ${label}: not applied in safe-default diagnostics`;
  }
  const affectedPath = fallback.affectedPath ?? path;
  return `  ${label}: not applied after validation failure; check ${affectedPath}`;
}

function doctorConfigValidationFallback(
  error: unknown,
): DoctorConfigValidationFallback | undefined {
  if (error instanceof ProjectOpenRouterAuthorizationError) {
    const projectDirectory = sanitizeTextForDisplay(error.projectDirectory);
    return {
      warning: `project config ${sanitizeTextForDisplay(error.projectPath)} changes Codex OpenRouter routing without user-global authorization. Doctor is using safe defaults for diagnostics.`,
      hint: `add the exact project directory ${JSON.stringify(projectDirectory)} to agents.codex.allowProjectProvider in user-global ${sanitizeTextForDisplay(error.globalConfigPath)} (for a new list: allowProjectProvider = [${JSON.stringify(projectDirectory)}]), then run \`kyoso doctor\` again`,
      affectedLayer: error.layer,
      affectedPath: sanitizeTextForDisplay(error.projectPath),
      trustedConfigExecution:
        error.layer === "project_ts" ? "authorization" : undefined,
    };
  }

  if (
    error instanceof Error &&
    /Project TOML config .*tools\.(?:planReview|securityReview|diffReview)/s.test(
      error.message,
    )
  ) {
    return {
      warning:
        "project TOML contains tools.* settings that are now user-global-only. Doctor is using safe defaults for diagnostics.",
      hint: "move tools.planReview, tools.securityReview, and tools.diffReview to the user-global config, then run `kyoso doctor` again",
      affectedLayer: "project_toml",
    };
  }

  return openRouterConfigValidationFallback(error);
}

function openRouterConfigValidationFallback(
  error: unknown,
): DoctorConfigValidationFallback | undefined {
  if (!(error instanceof z.ZodError)) return undefined;

  const issuePaths = error.issues.map((issue) =>
    issue.path.map(String).join("."),
  );
  const hasProjectProviderAllowlistIssue = error.issues.some((issue, index) =>
    isCodexProjectProviderAllowlistIssue(issue, issuePaths[index] ?? ""),
  );
  if (
    issuePaths.length === 0 ||
    !error.issues.some(
      (issue, index) =>
        isSupportedCodexProviderIssue(issue, issuePaths[index] ?? "") ||
        isCodexProjectProviderAllowlistIssue(issue, issuePaths[index] ?? ""),
    )
  ) {
    return undefined;
  }

  const detail = sanitizeTextForDisplay(
    error.issues
      .map(
        (issue, index) =>
          `${issuePaths[index] ?? "agents.codex"}: ${issue.message}`,
      )
      .join("; "),
  );
  const context = getConfigValidationContext(error);
  const configSource = context?.source;
  const trustedProjectTsSource =
    context?.projectTsExecuted && configSource?.layer === "project_ts"
      ? configSource
      : undefined;
  return {
    warning: `invalid Codex OpenRouter configuration: ${detail}. Doctor is using safe defaults for diagnostics.`,
    hint: hasProjectProviderAllowlistIssue
      ? 'migrate user-global agents.codex.allowProjectProvider to an absolute directory string[] for exact matching (for example: allowProjectProvider = ["/absolute/project-directory"]); remove legacy booleans and relative paths, then run `kyoso doctor` again'
      : 'set agents.codex.provider = "openrouter" with a non-empty agents.codex.model, or remove agents.codex.provider; then run `kyoso doctor` again',
    affectedLayer: trustedProjectTsSource ? "project_ts" : undefined,
    affectedPath: trustedProjectTsSource
      ? sanitizeTextForDisplay(trustedProjectTsSource.path)
      : undefined,
    trustedConfigExecution: trustedProjectTsSource ? "validation" : undefined,
  };
}

function isSupportedCodexProviderIssue(
  issue: z.core.$ZodIssue,
  path: string,
): boolean {
  if (path === "agents.codex.provider") {
    return issue.code === "invalid_value";
  }

  return (
    path === "agents.codex.model" &&
    issue.code === "custom" &&
    issue.params?.kyosoIssue === CODEX_OPENROUTER_MODEL_REQUIRED_ISSUE
  );
}

function isCodexProjectProviderAllowlistIssue(
  _issue: z.core.$ZodIssue,
  path: string,
): boolean {
  return (
    path === "agents.codex.allowProjectProvider" ||
    path.startsWith("agents.codex.allowProjectProvider.")
  );
}

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
  const hasReadyManualMcp =
    fallback.mode === "manual-mcp" || fallback.mode === "mcp-only";
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
  if (options.setup.manualMcpStatus === "enabled" && !hasReadyManualMcp) {
    return withPluginDetails(
      withIntegrationWarnings(
        fallback,
        [
          ...pluginWarnings,
          "Plugin MCP origin is unknown because an enabled manual MCP registration is legacy, custom, unverified, or its runner is unavailable.",
        ],
        "unknown",
        "unknown",
      ),
      "installed, enabled",
      "unknown",
    );
  }
  if (hasReadyManualMcp && override.status !== "disabled") {
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
  if (override.status === "disabled" && hasReadyManualMcp) {
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
    manualMcpRegistrations: setup.manualMcpRegistrations,
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
    `    manual MCP: ${formatManualMcpStatus(integration.setup, integration.cli)}`,
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
  lines.push(`    npx: ${formatRunnerAvailability(integration.cli.npx)}`);
  lines.push(`    bunx: ${formatRunnerAvailability(integration.cli.bunx)}`);
  if (integration.plugin) lines.push(`    Plugin: ${integration.plugin}`);
  if (integration.pluginMcp) {
    lines.push(`    Plugin MCP: ${integration.pluginMcp}`);
  }
  for (const warning of integration.warnings) {
    lines.push(`    warning: ${warning}`);
  }
  lines.push(`    ${integration.advice}`);
}

function formatManualMcpStatus(
  setup: SetupDetection,
  cli: CliDetection,
): string {
  if (setup.manualMcpStatus !== "enabled") return setup.manualMcpStatus;
  if (setup.manualMcpRegistrations.length !== 1) return "unknown";
  const invocation = setup.manualMcpRegistrations[0]?.invocation;
  if (invocation?.kind === "current") {
    if (invocation.runner === "npx") {
      return cli.npx === "available" ? "ok" : "npx missing";
    }
    if (invocation.runner === "bunx") {
      return cli.bunx === "missing" ? "bunx missing" : "bunx unverified";
    }
    return "unknown";
  }
  if (invocation?.kind === "legacy") return "repair required (legacy)";
  if (invocation?.kind === "custom") return "custom/unverified";
  return "unknown";
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
    return `next: run \`${formatKyosoPackageCommand({
      runner: "npx",
      cliArgs: ["setup", client, "--write", "--skill-only"],
    })}\``;
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
