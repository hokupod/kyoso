import { resolve } from "node:path";
import { kyosoConfigSchema, type KyosoConfig } from "../config/schema.js";
import { defaultConfig } from "../config/defaultConfig.js";
import { loadConfig, type LoadConfigOptions } from "../config/loadConfig.js";
import type { AcpAgentManager } from "../acp/AcpAgentManager.js";
import { SubprocessAcpAgentManager } from "../acp/AcpAgentProcess.js";
import { FakeAgentManager } from "../acp/FakeAgentManager.js";
import { buildAgentPrompt } from "../acp/prompts.js";
import { normalizeAgentOutput } from "../acp/normalize.js";
import { aggregateAgentResults } from "../aggregate/aggregateFindings.js";
import { createTraceWriter } from "../audit/trace.js";
import { buildContext } from "../context/buildContext.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./constants.js";
import { KyosoRequestError } from "./errors.js";
import type {
  AgentRunResult,
  CisaSecureByDesignResult,
  KyosoFinding,
  KyosoResult,
  KyosoReviewRequest,
  NetworkMode,
  ReviewTool,
  SecretScanResult,
} from "./types.js";
import { validateReviewRequest } from "./validateRequest.js";
import {
  defaultSummaryText,
  renderMarkdownResult,
} from "../output/markdown.js";
import { runJudge } from "../judge/provider.js";
import { assertNotChildAgent } from "../security/recursionGuard.js";
import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import { scanAndRedactSecrets } from "../security/secretScan.js";
import { computeCisaGate } from "../security/cisaGate.js";
import { decide } from "../security/decision.js";
import { createSnapshot, type Snapshot } from "../workspace/createSnapshot.js";
import { cleanupSnapshot } from "../workspace/cleanup.js";
import { newTraceId } from "../utils/ids.js";

export type RunReviewOptions = LoadConfigOptions & {
  config?: KyosoConfig;
  configHash?: string;
  agentManager?: AcpAgentManager;
  env?: NodeJS.ProcessEnv;
  mcpNetworkMode?: NetworkMode;
};

export async function runReview(
  tool: ReviewTool,
  request: KyosoReviewRequest,
  options: RunReviewOptions = {},
): Promise<KyosoResult> {
  const cwd = options.cwd ?? process.cwd();
  const traceId = newTraceId();
  const startedAt = new Date().toISOString();
  let snapshot: Snapshot | undefined;

  try {
    assertNotChildAgent(options.env ?? process.env);
  } catch (error) {
    if (error instanceof KyosoRequestError) {
      const config = kyosoConfigSchema.parse(defaultConfig);
      const trace = createTraceWriter({
        enabled: config.audit.enabled,
        directory: config.audit.directory,
        traceId,
        cwd,
      });
      await trace.write({
        type: "request_received",
        traceId,
        tool,
        timestamp: new Date().toISOString(),
      });
      return await buildPolicyBlockResult({
        tool,
        trace,
        traceId,
        startedAt,
        networkMode: config.network.defaultMode,
        warning: error.message,
        finding: {
          id: "KYOSO-1",
          severity: "critical",
          category: "other",
          title: "Recursive Kyoso invocation blocked",
          evidence: error.message,
          recommendation:
            "Do not expose Kyoso MCP tools to Kyoso child agents.",
          sourceAgents: ["kyoso_policy"],
          confidence: "high",
        },
        redactionsApplied: 0,
      });
    }
    throw error;
  }

  const loaded =
    options.config !== undefined
      ? {
          config: options.config,
          configHash: options.configHash,
          warnings: [] as string[],
        }
      : await loadConfig({
          cwd,
          configPath: options.configPath,
          ignoreConfig: options.ignoreConfig,
        });

  const trace = createTraceWriter({
    enabled: loaded.config.audit.enabled,
    directory: loaded.config.audit.directory,
    traceId,
    cwd,
    includeRawAgentOutput: loaded.config.audit.includeRawAgentOutput,
  });

  const warnings: string[] = [...loaded.warnings, ...trace.warnings];

  try {
    await trace.write({
      type: "request_received",
      traceId,
      tool,
      timestamp: new Date().toISOString(),
    });
    await trace.write({
      type: "config_loaded",
      traceId,
      configHash: loaded.configHash,
      timestamp: new Date().toISOString(),
    });

    validateReviewRequest(tool, request);
    assertTrustedWorkspaceRoot(
      request.workspace?.root,
      loaded.config.workspace.root,
      cwd,
    );
    const networkMode = resolveNetworkMode(
      request.options?.network,
      loaded.config.network.defaultMode,
      options.mcpNetworkMode,
    );
    if (
      networkMode === "unrestricted" &&
      !loaded.config.network.allowUnrestricted
    ) {
      throw new KyosoRequestError(
        "unrestricted network mode is disabled by config",
        "NETWORK_MODE_DISABLED",
      );
    }
    if (
      networkMode === "unrestricted" &&
      loaded.config.network.warnOnUnrestricted
    ) {
      warnings.push(
        "Network mode is unrestricted; write policy remains denied.",
      );
    }

    const secretScan = scanAndRedactSecrets(request);
    await trace.write({
      type: "secret_scan_completed",
      traceId,
      detected: secretScan.detected,
      redactions: secretScan.redactions,
      timestamp: new Date().toISOString(),
    });

    const allowSecretOverride =
      loaded.config.secrets.allowOverride &&
      request.options?.allowSecretRedaction === true;
    if (
      secretScan.detected &&
      loaded.config.secrets.blockOnDetectedSecret &&
      !allowSecretOverride
    ) {
      return await buildSecretBlockResult({
        tool,
        trace,
        traceId,
        startedAt,
        configHash: loaded.configHash,
        networkMode,
        secretScan,
        warnings,
      });
    }

    const denyPatterns = mergeDenyPatterns(
      loaded.config.workspace.deny,
      secretScan.redactedRequest.workspace?.denyRead,
    );
    const allowPatterns = secretScan.redactedRequest.workspace?.allowRead ?? [];
    const built = buildContext(secretScan.redactedRequest, {
      maxContextBytes: loaded.config.workspace.maxContextBytes,
      maxDiffBytes: loaded.config.workspace.maxDiffBytes,
      denyPatterns,
      allowPatterns,
    });
    warnings.push(...built.warnings);

    snapshot = await createSnapshot(traceId, tool, built.request, {
      denyPatterns,
      allowPatterns,
    });
    await trace.write({
      type: "snapshot_created",
      traceId,
      path: snapshot.root,
      fileCount: snapshot.fileCount,
      timestamp: new Date().toISOString(),
    });

    const agentResults = await runAgents({
      tool,
      request: built.request,
      config: loaded.config,
      traceId,
      workspaceDir: snapshot.root,
      networkMode,
      manager: options.agentManager ?? defaultAgentManager(loaded.config),
      trace,
    });

    const normalizedAgentResults = agentResults.map(normalizeAgentRunResult);
    const completed = normalizedAgentResults.filter(
      (result) => result.status === "completed",
    );
    const degraded = completed.length !== agentResults.length;
    let aggregate = aggregateAgentResults(normalizedAgentResults);

    if (secretScan.detected && allowSecretOverride) {
      aggregate = {
        ...aggregate,
        findings: reindexFindings([
          buildSecretFinding(secretScan, {
            id: "KYOSO-1",
            blocked: false,
          }),
          ...aggregate.findings,
        ]),
      };
    }

    if (completed.length === 0) {
      aggregate = {
        ...aggregate,
        findings: [
          ...aggregate.findings,
          {
            id: `KYOSO-${aggregate.findings.length + 1}`,
            severity: "critical",
            category: "other",
            title: "All backend agents failed",
            evidence: normalizedAgentResults
              .map(
                (result) =>
                  `${result.agent}: ${result.error?.code ?? result.status}`,
              )
              .join("; "),
            recommendation:
              "Run kyoso doctor and retry after agent authentication or adapter issues are fixed.",
            sourceAgents: ["kyoso_policy"],
            confidence: "high",
          },
        ],
      };
    }

    await trace.write({
      type: "aggregation_completed",
      traceId,
      findingCount: aggregate.findings.length,
      timestamp: new Date().toISOString(),
    });

    const cisa =
      tool === "security_review"
        ? computeCisaGate(aggregate.findings, normalizedAgentResults)
        : undefined;
    const decision = decide({
      tool,
      findings: aggregate.findings,
      cisa,
      degraded,
      secretScan: { detected: secretScan.detected, blocked: false },
    });

    const completedAt = new Date().toISOString();
    const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
      decision,
      degraded,
      findings: aggregate.findings,
      cisaSecureByDesign: cisa,
      disagreements: aggregate.disagreements,
      testsToAdd:
        tool === "security_review" && aggregate.testsToAdd.length === 0
          ? ["Add security regression tests for the reviewed behavior."]
          : aggregate.testsToAdd,
      residualRisks:
        tool === "security_review" && aggregate.residualRisks.length === 0
          ? [
              "No residual risks were reported by completed agents; verify security assumptions before release.",
            ]
          : aggregate.residualRisks,
      agentOpinions: normalizedAgentResults.map((result) =>
        agentOpinionSummary(
          result,
          request.options?.includeAgentRawOutputs === true,
        ),
      ),
      audit: {
        traceId,
        startedAt,
        completedAt,
        agentsUsed: normalizedAgentResults.map((result) => result.agent),
        redactionsApplied: secretScan.redactions,
        networkMode,
        workspaceMode: "temp_snapshot",
        configHash: loaded.configHash,
        warnings: Array.from(new Set([...warnings, ...trace.warnings])),
      },
    };
    const summaryText = defaultSummaryText(resultWithoutMarkdown);
    const judge = await runJudge({
      tool,
      result: resultWithoutMarkdown,
      summaryText,
      config: loaded.config.judge,
      requestedProvider: request.options?.judgeProvider,
      env: options.env ?? process.env,
    });
    const judgeComments = new Map(
      judge.output.disagreementComments.map((comment) => [
        comment.topic,
        comment.judgeComment,
      ]),
    );
    const disagreements = resultWithoutMarkdown.disagreements.map(
      (disagreement) => ({
        ...disagreement,
        judgeComment:
          judgeComments.get(disagreement.topic) ?? disagreement.judgeComment,
      }),
    );
    const result: KyosoResult = {
      ...resultWithoutMarkdown,
      disagreements,
      summaryMarkdown: renderMarkdownResult(
        tool,
        { ...resultWithoutMarkdown, disagreements },
        { summaryText: judge.output.summaryText },
      ),
    };
    const judgeEvent: Record<string, unknown> = {
      type: "judge_completed",
      traceId,
      provider: judge.provider,
      status: judge.status,
      timestamp: new Date().toISOString(),
    };
    if (judge.error) judgeEvent.error = judge.error;
    await trace.write(judgeEvent);
    result.audit.completedAt = new Date().toISOString();

    await trace.write({
      type: "decision_completed",
      traceId,
      decision,
      timestamp: new Date().toISOString(),
    });
    await trace.write({
      type: "response_sent",
      traceId,
      timestamp: new Date().toISOString(),
    });
    return result;
  } finally {
    if (snapshot) await cleanupSnapshot(snapshot.root);
  }
}

async function runAgents(input: {
  tool: ReviewTool;
  request: KyosoReviewRequest;
  config: KyosoConfig;
  traceId: string;
  workspaceDir: string;
  networkMode: "model_only" | "unrestricted";
  manager: AcpAgentManager;
  trace: { write(event: Record<string, unknown>): Promise<void> };
}): Promise<AgentRunResult[]> {
  const agentInputs = (["codex", "claude"] as const)
    .filter((agent) => input.config.agents[agent].enabled)
    .map((agent) => ({
      traceId: input.traceId,
      agent,
      role: input.config.agents[agent].role,
      tool: input.tool,
      prompt: buildAgentPrompt(input.tool, input.request, agent),
      workspaceDir: input.workspaceDir,
      timeoutMs:
        input.request.options?.maxAgentTimeoutMs ??
        input.config.agents[agent].timeoutMs ??
        DEFAULT_AGENT_TIMEOUT_MS,
      networkMode: input.networkMode,
    }));

  await Promise.all(
    agentInputs.map((agentInput) =>
      input.trace.write({
        type: "agent_started",
        traceId: input.traceId,
        agent: agentInput.agent,
        timestamp: new Date().toISOString(),
      }),
    ),
  );
  const results = await input.manager.runAll(agentInputs);
  await Promise.all(
    results.map((result) => {
      const event: Record<string, unknown> = {
        type: "agent_completed",
        traceId: input.traceId,
        agent: result.agent,
        status: result.status,
        timestamp: new Date().toISOString(),
      };
      if (input.config.audit.includeRawAgentOutput && result.rawText) {
        event.rawText = sanitizeTextForDisplay(result.rawText);
      }
      return input.trace.write(event);
    }),
  );
  return results;
}

function defaultAgentManager(config: KyosoConfig): AcpAgentManager {
  if (process.env.KYOSO_TEST_FAKE_AGENTS === "1") return new FakeAgentManager();
  return new SubprocessAcpAgentManager(config);
}

function normalizeAgentRunResult(result: AgentRunResult): AgentRunResult {
  if (result.status === "completed" && result.rawText && !result.normalized) {
    return {
      ...result,
      normalized: normalizeAgentOutput(
        result.agent,
        result.role,
        result.rawText,
      ),
    };
  }
  return result;
}

function agentOpinionSummary(
  result: AgentRunResult,
  includeRawText = false,
): KyosoResult["agentOpinions"][number] {
  const opinion: KyosoResult["agentOpinions"][number] = {
    agent: result.agent,
    role: result.role,
    summary:
      result.normalized?.summary ??
      sanitizeTextForDisplay(result.error?.message ?? result.status),
    status: result.status,
    errorCode: result.error?.code,
  };
  if (includeRawText && result.rawText) {
    opinion.rawText = sanitizeTextForDisplay(result.rawText);
  }
  return opinion;
}

async function buildSecretBlockResult(input: {
  tool: ReviewTool;
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
  startedAt: string;
  configHash?: string;
  networkMode: "model_only" | "unrestricted";
  secretScan: SecretScanResult;
  warnings: string[];
}): Promise<KyosoResult> {
  const finding = buildSecretFinding(input.secretScan, {
    id: "KYOSO-1",
    blocked: true,
  });
  const cisa: CisaSecureByDesignResult | undefined =
    input.tool === "security_review"
      ? computeCisaGate([finding], [])
      : undefined;
  const completedAt = new Date().toISOString();
  const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
    decision: "block",
    degraded: false,
    findings: [finding],
    cisaSecureByDesign: cisa,
    disagreements: [],
    testsToAdd:
      input.tool === "security_review"
        ? [
            "Add coverage that prevents secrets from being accepted in review input.",
          ]
        : [],
    residualRisks:
      input.tool === "security_review"
        ? [
            "Secret material was detected in review input; rotate affected credentials if they may have been exposed.",
          ]
        : [],
    agentOpinions: [
      {
        agent: "codex",
        role: "implementation_reviewer",
        summary: "Skipped because Kyoso blocked detected secrets.",
        status: "skipped",
      },
      {
        agent: "claude",
        role: "architecture_security_reviewer",
        summary: "Skipped because Kyoso blocked detected secrets.",
        status: "skipped",
      },
    ],
    audit: {
      traceId: input.traceId,
      startedAt: input.startedAt,
      completedAt,
      agentsUsed: [],
      redactionsApplied: input.secretScan.redactions,
      networkMode: input.networkMode,
      workspaceMode: "temp_snapshot",
      configHash: input.configHash,
      warnings: input.warnings,
    },
  };
  const result: KyosoResult = {
    ...resultWithoutMarkdown,
    summaryMarkdown: renderMarkdownResult(input.tool, resultWithoutMarkdown),
  };
  await input.trace.write({
    type: "decision_completed",
    traceId: input.traceId,
    decision: "block",
    timestamp: new Date().toISOString(),
  });
  await input.trace.write({
    type: "response_sent",
    traceId: input.traceId,
    timestamp: new Date().toISOString(),
  });
  return result;
}

function buildSecretFinding(
  secretScan: SecretScanResult,
  options: { id: string; blocked: boolean },
): KyosoFinding {
  return {
    id: options.id,
    severity: options.blocked ? "critical" : "medium",
    category: "secret",
    title: options.blocked
      ? "Secret detected in review input"
      : "Secret detected and redacted in review input",
    evidence: secretScan.matches
      .map((match) => `${match.kind} at ${match.location}`)
      .join("; "),
    recommendation: options.blocked
      ? "Remove the secret from the request or source file, rotate it if exposed, then retry with redacted input."
      : "Remove the secret from source input and rotate it if it was exposed; Kyoso continued only with redacted content.",
    sourceAgents: ["kyoso_policy"],
    confidence: "high",
    cisaMapping: [
      "customer_security_outcomes",
      "secure_by_default",
      "governance",
    ],
  };
}

function reindexFindings(findings: KyosoFinding[]): KyosoFinding[] {
  return findings.map((finding, index) => ({
    ...finding,
    id: `KYOSO-${index + 1}`,
  }));
}

async function buildPolicyBlockResult(input: {
  tool: ReviewTool;
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
  startedAt: string;
  configHash?: string;
  networkMode: "model_only" | "unrestricted";
  warning: string;
  finding: KyosoFinding;
  redactionsApplied: number;
}): Promise<KyosoResult> {
  const completedAt = new Date().toISOString();
  const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
    decision: "block",
    degraded: false,
    findings: [input.finding],
    cisaSecureByDesign:
      input.tool === "security_review"
        ? computeCisaGate([input.finding], [])
        : undefined,
    disagreements: [],
    testsToAdd:
      input.tool === "security_review"
        ? ["Add coverage for this Kyoso policy block path."]
        : [],
    residualRisks: input.tool === "security_review" ? [input.warning] : [],
    agentOpinions: [],
    audit: {
      traceId: input.traceId,
      startedAt: input.startedAt,
      completedAt,
      agentsUsed: [],
      redactionsApplied: input.redactionsApplied,
      networkMode: input.networkMode,
      workspaceMode: "temp_snapshot",
      configHash: input.configHash,
      warnings: [input.warning],
    },
  };
  const result: KyosoResult = {
    ...resultWithoutMarkdown,
    summaryMarkdown: renderMarkdownResult(input.tool, resultWithoutMarkdown),
  };
  await input.trace.write({
    type: "decision_completed",
    traceId: input.traceId,
    decision: "block",
    timestamp: new Date().toISOString(),
  });
  await input.trace.write({
    type: "response_sent",
    traceId: input.traceId,
    timestamp: new Date().toISOString(),
  });
  return result;
}

function mergeDenyPatterns(
  configDeny: string[],
  requestDeny: string[] | undefined,
): string[] {
  return Array.from(new Set([...configDeny, ...(requestDeny ?? [])]));
}

function assertTrustedWorkspaceRoot(
  requestRoot: string | undefined,
  configRoot: string,
  cwd: string,
): void {
  if (!requestRoot) return;
  if (resolve(cwd, requestRoot) !== resolve(cwd, configRoot)) {
    throw new KyosoRequestError(
      "workspace.root is not trusted by config",
      "UNTRUSTED_WORKSPACE_ROOT",
    );
  }
}

function resolveNetworkMode(
  requested: NetworkMode | undefined,
  configDefault: NetworkMode,
  mcpNetworkMode: NetworkMode | undefined,
): NetworkMode {
  if (mcpNetworkMode === "model_only" && requested === "unrestricted") {
    throw new KyosoRequestError(
      "unrestricted network mode is disabled by MCP --network model_only",
      "NETWORK_MODE_DISABLED",
    );
  }
  return requested ?? configDefault;
}
