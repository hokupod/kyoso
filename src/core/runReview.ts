import { resolve } from "node:path";
import {
  CODEX_OPENROUTER_PROVIDER,
  kyosoConfigSchema,
  type KyosoConfig,
} from "../config/schema.js";
import { defaultConfig } from "../config/defaultConfig.js";
import { loadConfig, type LoadConfigOptions } from "../config/loadConfig.js";
import { applyConfigOverrides } from "../config/configOverrides.js";
import type { AcpAgentManager } from "../acp/AcpAgentManager.js";
import { SubprocessAcpAgentManager } from "../acp/AcpAgentProcess.js";
import { FakeAgentManager } from "../acp/FakeAgentManager.js";
import {
  buildAgentPrompt,
  buildFindingVerifierPrompt,
} from "../acp/prompts.js";
import { normalizeAgentOutput } from "../acp/normalize.js";
import { aggregateAgentResults } from "../aggregate/aggregateFindings.js";
import {
  createTraceWriter,
  type TraceWriter,
  type TraceWriterOptions,
} from "../audit/trace.js";
import { buildContext } from "../context/buildContext.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./constants.js";
import { KyosoRequestError } from "./errors.js";
import type {
  AgentName,
  AgentRunResult,
  AgentRole,
  CisaSecureByDesignResult,
  CrossModelAnalysis,
  JudgeProvider,
  KyosoFinding,
  KyosoResult,
  KyosoReviewRequest,
  ModelExecutionIdentity,
  NetworkMode,
  NormalizedAgentOpinion,
  ReviewCoverage,
  ReviewLens,
  ResolvedReviewBudget,
  ReviewTool,
  SecretScanResult,
} from "./types.js";
import { normalizeModelExecutionIdentity } from "./modelExecutionIdentity.js";
import { validateReviewRequest } from "./validateRequest.js";
import {
  defaultSummaryText,
  renderMarkdownResult,
} from "../output/markdown.js";
import {
  resolveJudgeCallRoute,
  runJudge,
  type JudgeRunInput,
  type JudgeRunResult,
} from "../judge/provider.js";
import { assertNotChildAgent } from "../security/recursionGuard.js";
import {
  sanitizeText,
  sanitizeTextForDisplay,
  sanitizeTextForRawOutput,
} from "../security/sanitizeText.js";
import { scanAndRedactSecrets } from "../security/secretScan.js";
import { computeCisaGate } from "../security/cisaGate.js";
import { decide } from "../security/decision.js";
import { createSnapshot, type Snapshot } from "../workspace/createSnapshot.js";
import { cleanupSnapshot } from "../workspace/cleanup.js";
import { newTraceId } from "../utils/ids.js";
import { createRequestFingerprint } from "./requestFingerprint.js";
import { normalizeModelTokenUsage } from "./tokenUsage.js";
import {
  buildReviewModelCallPlan,
  ReviewBudgetTracker,
  resolveReviewBudget,
  type ModelCallReservation,
} from "./reviewBudget.js";
import {
  admitFindings,
  buildAdmissionOpenQuestions,
  findingFingerprint,
  selectRegressionTests,
} from "./findingAdmission.js";
import {
  buildReviewCoverage,
  isCoverageIncomplete,
  resolveRequiredLenses,
  unavailableReviewCoverage,
} from "./reviewPolicy.js";
import {
  applyVerificationVerdicts,
  countVerificationStatuses,
  groupVerificationTargetsByVerifier,
  markVerificationOverflow,
  parseVerificationVerdicts,
  selectVerificationTargets,
} from "./verification.js";

export type RunReviewOptions = LoadConfigOptions & {
  config?: KyosoConfig;
  configOverrides?: string[];
  configHash?: string;
  agentManager?: AcpAgentManager;
  env?: NodeJS.ProcessEnv;
  mcpNetworkMode?: NetworkMode;
  entrypoint?: "cli" | "mcp" | "core";
  traceWriterFactory?: (options: TraceWriterOptions) => TraceWriter;
};

function requestForRecursionFingerprint(
  request: KyosoReviewRequest,
): KyosoReviewRequest {
  try {
    return scanAndRedactSecrets(request).redactedRequest;
  } catch {
    return { goal: "" };
  }
}

export async function runReview(
  tool: ReviewTool,
  request: KyosoReviewRequest,
  options: RunReviewOptions = {},
): Promise<KyosoResult> {
  const cwd = options.cwd ?? process.cwd();
  const traceId = newTraceId();
  const startedAtEpochMs = Date.now();
  const startedAt = new Date(startedAtEpochMs).toISOString();
  const auditEnv = { ...process.env, ...options.env };
  const traceWriterFactory = options.traceWriterFactory ?? createTraceWriter;
  let snapshot: Snapshot | undefined;

  try {
    assertNotChildAgent(options.env ?? process.env);
  } catch (error) {
    if (error instanceof KyosoRequestError) {
      const config = kyosoConfigSchema.parse(defaultConfig);
      const reviewBudget = resolveReviewBudget(config.reviewBudget, undefined);
      const budgetTracker = new ReviewBudgetTracker(
        reviewBudget,
        startedAtEpochMs,
        configuredReviewModelCallPlan(
          config,
          reviewBudget,
          options.env ?? process.env,
        ),
      );
      const requestFingerprint = createRequestFingerprint({
        tool,
        request: requestForRecursionFingerprint(request),
        config,
        roles: resolveAgentRoles(config),
        budget: reviewBudget,
        entrypoint: options.entrypoint,
      });
      const trace = traceWriterFactory({
        enabled: config.audit.enabled,
        directory: config.audit.directory,
        traceId,
        cwd,
        env: auditEnv,
      });
      try {
        await trace.write({
          type: "request_received",
          traceId,
          tool,
          timestamp: new Date().toISOString(),
        });
        await writeReviewBudgetPlanned({
          trace,
          traceId,
          budgetTracker,
          requestFingerprint,
        });
        return await buildPolicyBlockResult({
          tool,
          trace,
          traceId,
          startedAt,
          networkMode: config.network.defaultMode,
          cisaPolicy: config.securityReview.cisaSecureByDesign,
          warning: error.message,
          budgetTracker,
          requestFingerprint,
          coverage: unavailableReviewCoverage(
            requestForRecursionFingerprint(request),
            "recursive invocation blocked before agent execution",
            config.reviewPolicy.additionalLenses,
          ),
          finding: {
            id: "KYOSO-1",
            severity: "critical",
            category: "other",
            title: "Recursive Kyoso invocation blocked",
            evidence: error.message,
            recommendation:
              "Do not expose Kyoso MCP tools to Kyoso child agents.",
            disposition: "gate",
            changeRelation: "unknown",
            evidenceQuality: "concrete",
            evidenceRefs: [],
            policyReasons: ["kyoso_policy", "recursive_invocation"],
            fingerprint: "",
            sourceAgents: ["kyoso_policy"],
            confidence: "high",
          },
          redactionsApplied: 0,
        });
      } finally {
        await trace.finalize();
      }
    }
    throw error;
  }

  const baseLoaded =
    options.config !== undefined
      ? {
          config: options.config,
          configHash: options.configHash,
          configTrustStatus: "trusted" as const,
          sources: [],
          warnings: [] as string[],
        }
      : await loadConfig({
          cwd,
          configPath: options.configPath,
          ignoreConfig: options.ignoreConfig,
          trustConfig: options.trustConfig,
          allowUnknownConfig: options.allowUnknownConfig,
          promptForTrust: options.promptForTrust,
          trustStorePath: options.trustStorePath,
          env: options.env,
          trustPrompt: options.trustPrompt,
        });
  const loaded =
    options.configOverrides && options.configOverrides.length > 0
      ? {
          ...baseLoaded,
          config: applyConfigOverrides(
            baseLoaded.config,
            options.configOverrides,
          ),
        }
      : baseLoaded;

  const trace = traceWriterFactory({
    enabled: loaded.config.audit.enabled,
    directory: loaded.config.audit.directory,
    traceId,
    cwd,
    includeRawAgentOutput: loaded.config.audit.includeRawAgentOutput,
    env: auditEnv,
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
      configPath: loaded.configPath,
      configSources: loaded.sources,
      configTrustStatus: loaded.configTrustStatus,
      timestamp: new Date().toISOString(),
    });

    validateReviewRequest(tool, request);
    const reviewBudget = resolveReviewBudget(
      loaded.config.reviewBudget,
      request.options?.reviewBudget,
    );
    const budgetTracker = new ReviewBudgetTracker(
      reviewBudget,
      startedAtEpochMs,
      configuredReviewModelCallPlan(
        loaded.config,
        reviewBudget,
        options.env ?? process.env,
        request.options?.judgeProvider,
      ),
    );
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

    const disabledPolicy = disabledReviewPolicy(
      tool,
      loaded.config,
      options.entrypoint,
    );
    if (disabledPolicy) {
      const redactedRequest = requestForRecursionFingerprint(request);
      const requestFingerprint = createRequestFingerprint({
        tool,
        request: redactedRequest,
        config: loaded.config,
        roles: resolveAgentRoles(loaded.config),
        budget: reviewBudget,
        entrypoint: options.entrypoint,
      });
      await writeReviewBudgetPlanned({
        trace,
        traceId,
        budgetTracker,
        requestFingerprint,
      });
      const warning = disabledPolicy.warning;
      return await buildPolicyBlockResult({
        tool,
        trace,
        traceId,
        startedAt,
        configHash: loaded.configHash,
        networkMode,
        cisaPolicy: loaded.config.securityReview.cisaSecureByDesign,
        warning,
        budgetTracker,
        requestFingerprint,
        coverage: unavailableReviewCoverage(
          redactedRequest,
          disabledPolicy.coverageReason,
          loaded.config.reviewPolicy.additionalLenses,
        ),
        finding: {
          id: "KYOSO-1",
          severity: "critical",
          category: "other",
          title: disabledPolicy.title,
          evidence: warning,
          recommendation: disabledPolicy.recommendation,
          disposition: "gate",
          changeRelation: "unknown",
          evidenceQuality: "concrete",
          evidenceRefs: [],
          policyReasons: ["kyoso_policy", disabledPolicy.policyReason],
          fingerprint: "",
          sourceAgents: ["kyoso_policy"],
          confidence: "high",
        },
        redactionsApplied: 0,
      });
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
      const requestFingerprint = createRequestFingerprint({
        tool,
        request: secretScan.redactedRequest,
        config: loaded.config,
        roles: resolveAgentRoles(loaded.config),
        budget: reviewBudget,
        entrypoint: options.entrypoint,
      });
      await writeReviewBudgetPlanned({
        trace,
        traceId,
        budgetTracker,
        requestFingerprint,
      });
      return await buildSecretBlockResult({
        tool,
        trace,
        traceId,
        startedAt,
        configHash: loaded.configHash,
        networkMode,
        cisaPolicy: loaded.config.securityReview.cisaSecureByDesign,
        additionalLenses: loaded.config.reviewPolicy.additionalLenses,
        secretScan,
        warnings,
        budgetTracker,
        requestFingerprint,
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

    const agentRoles = resolveAgentRoles(loaded.config);
    const requestFingerprint = createRequestFingerprint({
      tool,
      request: built.request,
      config: loaded.config,
      roles: agentRoles,
      budget: reviewBudget,
      entrypoint: options.entrypoint,
    });
    await writeReviewBudgetPlanned({
      trace,
      traceId,
      budgetTracker,
      requestFingerprint,
    });
    warnings.push(...plannedBudgetWarnings(budgetTracker));
    snapshot = await createSnapshot(traceId, tool, built.request, {
      denyPatterns,
      allowPatterns,
      agentRoles,
    });
    await trace.write({
      type: "snapshot_created",
      traceId,
      path: snapshot.root,
      fileCount: snapshot.fileCount,
      timestamp: new Date().toISOString(),
    });

    const manager =
      options.agentManager ??
      defaultAgentManager(loaded.config, options.env ?? process.env);
    const agentResults = await runAgents({
      tool,
      request: built.request,
      config: loaded.config,
      traceId,
      workspaceDir: snapshot.root,
      networkMode,
      manager,
      trace,
      warnings,
      budgetTracker,
    });

    warnings.push(
      ...agentResults.flatMap((result) =>
        (result.warnings ?? []).map(
          (warning) => `Agent ${result.agent} ${warning}`,
        ),
      ),
    );

    const normalizedAgentResults = agentResults.map((result) =>
      normalizeAgentRunResult(result, reviewBudget.maxFindingsPerAgent),
    );
    for (const result of normalizedAgentResults.filter(
      (item) => item.findingsTargetExceeded,
    )) {
      warnings.push(
        `Agent ${result.agent} reported ${result.reportedFindings} findings, above the soft target of ${reviewBudget.maxFindingsPerAgent}; all findings were retained.`,
      );
    }
    const enabledAgents = (["codex", "claude"] as const).filter(
      (agent) => loaded.config.agents[agent].enabled,
    );
    const agentsUsed = normalizedAgentResults
      .filter((result) => result.status !== "skipped")
      .map((result) => result.agent);
    const reviewMode =
      enabledAgents.length === 1 ? "single_agent" : "multi_agent";
    const completed = normalizedAgentResults.filter(
      (result) => result.status === "completed",
    );
    const attempted = normalizedAgentResults.filter(
      (result) => result.status !== "skipped",
    );
    const degraded =
      completed.length !== attempted.length || enabledAgents.length === 0;
    const coverage = buildReviewCoverage({
      request: built.request,
      additionalLenses: loaded.config.reviewPolicy.additionalLenses,
      agentResults: normalizedAgentResults,
    });
    if (
      isCoverageIncomplete(coverage, {
        multiAgentRequired: loaded.config.reviewPolicy.multiAgentRequired,
      })
    ) {
      budgetTracker.markIncomplete("coverage_incomplete");
      warnings.push(formatCoverageWarning(coverage, loaded.config));
    }
    let aggregate = aggregateAgentResults(normalizedAgentResults, {
      reviewMode,
    });

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

    if (
      completed.length === 0 &&
      (attempted.length > 0 || enabledAgents.length === 0)
    ) {
      const noPrimaryAgents = enabledAgents.length === 0;
      if (noPrimaryAgents) {
        budgetTracker.markIncomplete("coverage_incomplete");
        warnings.push(
          "No primary review agents are enabled; review coverage is incomplete.",
        );
      }
      aggregate = {
        ...aggregate,
        findings: [
          ...aggregate.findings,
          {
            id: `KYOSO-${aggregate.findings.length + 1}`,
            severity: "critical",
            category: "other",
            title: noPrimaryAgents
              ? "No primary review agents enabled"
              : "All backend agents failed",
            evidence: noPrimaryAgents
              ? "Both configured primary reviewers are disabled."
              : normalizedAgentResults
                  .map(
                    (result) =>
                      `${result.agent}: ${result.error?.code ?? result.status}`,
                  )
                  .join("; "),
            recommendation: noPrimaryAgents
              ? "Enable at least one primary reviewer before running Kyoso."
              : "Run kyoso doctor and retry after agent authentication or adapter issues are fixed.",
            disposition: "gate",
            changeRelation: "unknown",
            evidenceQuality: "concrete",
            evidenceRefs: [],
            policyReasons: ["kyoso_policy", "coverage_incomplete"],
            fingerprint: "",
            sourceAgents: ["kyoso_policy"],
            confidence: "high",
          },
        ],
      };
    }

    aggregate = {
      ...aggregate,
      findings: admitFindings({
        tool,
        request: built.request,
        findings: aggregate.findings,
        reviewMode,
      }),
    };

    await trace.write({
      type: "aggregation_completed",
      traceId,
      findingCount: aggregate.findings.length,
      timestamp: new Date().toISOString(),
    });

    const verificationMode =
      loaded.config.verification.enabled && reviewMode === "single_agent"
        ? "skipped_single_agent"
        : loaded.config.verification.enabled && enabledAgents.length > 1
          ? "cross_agent"
          : undefined;
    if (verificationMode === "cross_agent") {
      warnings.push(
        ...(await runFindingVerification({
          tool,
          request: built.request,
          config: loaded.config,
          traceId,
          workspaceDir: snapshot.root,
          networkMode,
          manager,
          trace,
          findings: aggregate.findings,
          budgetTracker,
        })),
      );
    }

    aggregate = {
      ...aggregate,
      findings: admitFindings({
        tool,
        request: built.request,
        findings: aggregate.findings,
        reviewMode,
      }),
    };

    if (
      aggregate.findings.some((finding) => finding.disposition === "disputed")
    ) {
      budgetTracker.markIncomplete("disputed_finding");
    }

    const cisaPolicy = loaded.config.securityReview.cisaSecureByDesign;
    const cisa =
      tool === "security_review" && cisaPolicy.enabled
        ? computeCisaGate(
            aggregate.findings,
            normalizedAgentResults,
            cisaPolicy,
          )
        : undefined;
    const budgetBeforeJudge = budgetTracker.snapshot();
    const decision =
      budgetBeforeJudge.completion.status === "incomplete"
        ? "block"
        : decide({
            tool,
            findings: aggregate.findings,
            cisa: cisaPolicy.gate ? cisa : undefined,
            degraded,
            secretScan: { detected: secretScan.detected, blocked: false },
          });

    const completedAt = new Date().toISOString();
    const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
      decision,
      completion: budgetBeforeJudge.completion,
      executionBudget: budgetBeforeJudge.executionBudget,
      requestFingerprint,
      degraded,
      agentsUsed,
      reviewMode,
      coverage,
      ...(verificationMode ? { verificationMode } : {}),
      findings: aggregate.findings,
      cisaSecureByDesign: cisa,
      disagreements: aggregate.disagreements,
      testsToAdd: selectRegressionTests(aggregate.testsToAdd),
      residualRisks:
        tool === "security_review" && aggregate.residualRisks.length === 0
          ? [
              "No residual risks were reported by completed agents; verify security assumptions before release.",
            ]
          : aggregate.residualRisks,
      openQuestions: Array.from(
        new Set([
          ...aggregate.openQuestions,
          ...buildAdmissionOpenQuestions(aggregate.findings),
        ]),
      ),
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
        agentsUsed,
        redactionsApplied: secretScan.redactions,
        networkMode,
        workspaceMode: "temp_snapshot",
        configHash: loaded.configHash,
        warnings: Array.from(new Set([...warnings, ...trace.warnings])),
        modelCalls: budgetBeforeJudge.modelCalls,
      },
    };
    const summaryText = defaultSummaryText(resultWithoutMarkdown);
    const judge = await runBudgetedJudge({
      tool,
      result: resultWithoutMarkdown,
      summaryText,
      agentFindings: buildJudgeAgentFindings(normalizedAgentResults),
      config: loaded.config.judge,
      requestedProvider: request.options?.judgeProvider,
      env: options.env ?? process.env,
      budgetTracker,
      trace,
      traceId,
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
    const crossModelAnalysis = buildCrossModelAnalysis(judge, reviewMode);
    const budgetAfterJudge = budgetTracker.snapshot();
    const finalWarnings = Array.from(
      new Set([
        ...(resultWithoutMarkdown.audit.warnings ?? []),
        ...outputWarningMessages(budgetAfterJudge),
        ...tokenUsageWarningMessages(budgetTracker, budgetAfterJudge),
      ]),
    );
    const finalDecision =
      budgetAfterJudge.completion.status === "incomplete" ? "block" : decision;
    const resultAfterJudge: Omit<KyosoResult, "summaryMarkdown"> = {
      ...resultWithoutMarkdown,
      decision: finalDecision,
      completion: budgetAfterJudge.completion,
      executionBudget: budgetAfterJudge.executionBudget,
      disagreements,
      ...(crossModelAnalysis ? { crossModelAnalysis } : {}),
      audit: {
        ...resultWithoutMarkdown.audit,
        completedAt: new Date().toISOString(),
        warnings: finalWarnings,
        modelCalls: budgetAfterJudge.modelCalls,
      },
    };
    const judgeEvent: Record<string, unknown> = {
      type: "judge_completed",
      traceId,
      provider: judge.provider,
      status: judge.status,
      ...(judge.executionIdentity
        ? { executionIdentity: judge.executionIdentity }
        : {}),
      timestamp: new Date().toISOString(),
    };
    if (judge.error) judgeEvent.error = judge.error;
    await trace.write(judgeEvent);
    resultAfterJudge.audit.completedAt = new Date().toISOString();

    await writeReviewBudgetCompleted({
      trace,
      traceId,
      budgetTracker,
      requestFingerprint,
    });

    await trace.write({
      type: "decision_completed",
      traceId,
      decision: finalDecision,
      timestamp: new Date().toISOString(),
    });
    await trace.write({
      type: "response_sent",
      traceId,
      timestamp: new Date().toISOString(),
    });
    return await finalizeReviewResult({
      tool,
      trace,
      result: resultAfterJudge,
      summaryText:
        resultAfterJudge.completion.status === "incomplete"
          ? defaultSummaryText(resultAfterJudge)
          : judge.output.summaryText,
    });
  } finally {
    await trace.finalize();
    if (snapshot) await cleanupSnapshot(snapshot.root);
  }
}

async function runFindingVerification(input: {
  tool: ReviewTool;
  request: KyosoReviewRequest;
  config: KyosoConfig;
  traceId: string;
  workspaceDir: string;
  networkMode: NetworkMode;
  manager: AcpAgentManager;
  trace: { write(event: Record<string, unknown>): Promise<void> };
  findings: KyosoFinding[];
  budgetTracker: ReviewBudgetTracker;
}): Promise<string[]> {
  // Phase 1: allowDemotion is intentionally a no-op. Verification may adjust
  // confidence and notes, but it never changes severity or decision.
  const allowDemotionRequested = input.config.verification.allowDemotion;
  const selection = selectVerificationTargets(
    input.findings,
    input.config.verification.maxFindings,
  );
  const warnings: string[] = [];
  if (selection.overflow.length > 0) {
    markVerificationOverflow(selection.overflow, "verification_max_findings");
    input.budgetTracker.markIncomplete("coverage_incomplete");
  }
  if (selection.selected.length === 0) return warnings;

  const potentialGroups = groupVerificationTargetsByVerifier(
    selection.selected,
  );
  await input.trace.write({
    type: "verification_started",
    traceId: input.traceId,
    targetCount: selection.selected.length,
    notVerifiedCount: selection.overflow.length,
    verifierCount: potentialGroups.length,
    timeoutMs: input.config.verification.timeoutMs,
    allowDemotionRequested,
    timestamp: new Date().toISOString(),
  });

  if (
    input.budgetTracker.budget.skipOptionalPhasesWhenTokenUsageUnknown &&
    input.budgetTracker.isTokenUsageUnknown()
  ) {
    markVerificationOverflow(selection.selected, "token_usage_unknown");
    input.budgetTracker.markIncomplete("token_usage_unknown");
    input.budgetTracker.markIncomplete("coverage_incomplete");
    warnings.push(
      "Finding verification was skipped because primary-agent token usage was not reported.",
    );
    for (const group of potentialGroups) {
      input.budgetTracker.recordSkipped({
        kind: "verifier",
        agent: group.verifier,
        reason: "token_usage_unknown",
      });
      await input.trace.write({
        type: "model_call_skipped",
        traceId: input.traceId,
        kind: "verifier",
        agent: group.verifier,
        reason: "token_usage_unknown",
        timestamp: new Date().toISOString(),
      });
    }
    await input.trace.write({
      type: "verification_completed",
      traceId: input.traceId,
      counts: countVerificationStatuses(input.findings),
      timestamp: new Date().toISOString(),
    });
    return warnings;
  }

  type VerificationGroup = {
    verifier: AgentName;
    targets: typeof selection.selected;
    reservation: ModelCallReservation;
  };
  const groups = new Map<AgentName, VerificationGroup>();
  const unavailableVerifiers = new Map<
    AgentName,
    "model_call_budget" | "deadline"
  >();
  for (const target of selection.selected) {
    const existing = groups.get(target.verifier);
    if (existing) {
      existing.targets.push(target);
      continue;
    }
    const unavailable = unavailableVerifiers.get(target.verifier);
    if (unavailable) {
      markVerificationOverflow(
        [target],
        unavailable === "model_call_budget" ? "budget_exhausted" : "deadline",
      );
      continue;
    }

    const reservationResult = input.budgetTracker.reserve({
      kind: "verifier",
      agent: target.verifier,
    });
    if ("failure" in reservationResult) {
      unavailableVerifiers.set(
        target.verifier,
        reservationResult.failure.reason,
      );
      markVerificationOverflow(
        [target],
        reservationResult.failure.reason === "model_call_budget"
          ? "budget_exhausted"
          : "deadline",
      );
      input.budgetTracker.recordSkipped({
        kind: "verifier",
        agent: target.verifier,
        reason: reservationResult.failure.reason,
      });
      input.budgetTracker.markIncomplete(reservationResult.failure.reason);
      input.budgetTracker.markIncomplete("coverage_incomplete");
      await input.trace.write({
        type: "review_budget_exhausted",
        traceId: input.traceId,
        phase: "verification",
        kind: "verifier",
        agent: target.verifier,
        reason: reservationResult.failure.reason,
        timestamp: new Date().toISOString(),
      });
      await input.trace.write({
        type: "model_call_skipped",
        traceId: input.traceId,
        kind: "verifier",
        agent: target.verifier,
        reason: reservationResult.failure.reason,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    const group = {
      verifier: target.verifier,
      targets: [target],
      reservation: reservationResult.reservation,
    };
    groups.set(target.verifier, group);
    await input.trace.write({
      type: "model_call_reserved",
      traceId: input.traceId,
      kind: "verifier",
      agent: target.verifier,
      timestamp: new Date().toISOString(),
    });
  }

  const scheduledGroups: VerificationGroup[] = [];
  for (const group of groups.values()) {
    const timeoutMs = Math.min(
      input.config.verification.timeoutMs,
      input.budgetTracker.remainingWallTimeMs(),
    );
    if (timeoutMs > 0) {
      scheduledGroups.push(group);
      continue;
    }
    input.budgetTracker.skip(group.reservation, "deadline");
    input.budgetTracker.markIncomplete("deadline");
    input.budgetTracker.markIncomplete("coverage_incomplete");
    markVerificationOverflow(group.targets, "deadline");
    await input.trace.write({
      type: "review_budget_exhausted",
      traceId: input.traceId,
      phase: "verification",
      kind: "verifier",
      agent: group.verifier,
      reason: "deadline",
      timestamp: new Date().toISOString(),
    });
    await input.trace.write({
      type: "model_call_skipped",
      traceId: input.traceId,
      kind: "verifier",
      agent: group.verifier,
      reason: "deadline",
      timestamp: new Date().toISOString(),
    });
  }
  if (scheduledGroups.length === 0) {
    await input.trace.write({
      type: "verification_completed",
      traceId: input.traceId,
      counts: countVerificationStatuses(input.findings),
      timestamp: new Date().toISOString(),
    });
    return warnings;
  }

  const agentInputs = scheduledGroups.map((group) => ({
    traceId: input.traceId,
    agent: group.verifier,
    role: "finding_verifier" as const,
    tool: input.tool,
    prompt: buildFindingVerifierPrompt(
      input.tool,
      input.request,
      group.verifier,
      group.targets.map((target) => target.finding),
      {
        requiredLenses: resolveRequiredLenses(
          input.request,
          input.config.reviewPolicy.additionalLenses,
        ),
      },
    ),
    workspaceDir: input.workspaceDir,
    timeoutMs: Math.min(
      input.config.verification.timeoutMs,
      input.budgetTracker.remainingWallTimeMs(),
    ),
    deadlineAtEpochMs: input.budgetTracker.deadlineAtEpochMs,
    warnOutputBytes: input.budgetTracker.budget.effectiveWarnAgentOutputBytes,
    maxOutputBytes: input.budgetTracker.budget.maxAgentOutputBytes,
    networkMode: input.networkMode,
    onStarted: (executionIdentity?: ModelExecutionIdentity) => {
      input.budgetTracker.markStarted(group.reservation, executionIdentity);
      const event = buildAgentStartedEvent({
        traceId: input.traceId,
        agent: group.verifier,
        role: "finding_verifier",
        executionIdentity: input.budgetTracker.executionIdentity(
          group.reservation,
        ),
      });
      return input.trace.write(event).catch(() => {
        warnings.push(
          "AUDIT_WRITE_FAILED: agent_started event could not be recorded.",
        );
      });
    },
  }));

  let results: AgentRunResult[];
  try {
    results = await input.manager.runAll(agentInputs);
  } catch (error) {
    for (const group of scheduledGroups) {
      applyVerificationVerdicts(group.targets, group.verifier, undefined);
      await finalizeModelCallResult({
        budgetTracker: input.budgetTracker,
        reservation: group.reservation,
        result: failedVerifierResult(group.verifier, "AGENT_MANAGER_FAILED"),
        trace: input.trace,
        traceId: input.traceId,
      });
      input.budgetTracker.markIncomplete("coverage_incomplete");
    }
    const message = `Finding verification failed: ${sanitizeTextForDisplay(
      error instanceof Error ? error.message : String(error),
    )}`;
    warnings.push(message);
    await input.trace.write({
      type: "verification_failed",
      traceId: input.traceId,
      error: message,
      counts: countVerificationStatuses(input.findings),
      timestamp: new Date().toISOString(),
    });
    return warnings;
  }

  const resultByAgent = new Map(
    results.map((result) => [result.agent, result]),
  );
  for (const group of scheduledGroups) {
    const result = resultByAgent.get(group.verifier);
    if (!result) {
      applyVerificationVerdicts(group.targets, group.verifier, undefined);
      await finalizeModelCallResult({
        budgetTracker: input.budgetTracker,
        reservation: group.reservation,
        result: failedVerifierResult(group.verifier, "AGENT_RESULT_MISSING"),
        trace: input.trace,
        traceId: input.traceId,
      });
      input.budgetTracker.markIncomplete("coverage_incomplete");
      warnings.push(
        `Finding verification by ${group.verifier} did not return a result.`,
      );
      continue;
    }
    await finalizeModelCallResult({
      budgetTracker: input.budgetTracker,
      reservation: group.reservation,
      result,
      trace: input.trace,
      traceId: input.traceId,
    });
    if (result.status !== "completed") {
      applyVerificationVerdicts(group.targets, result.agent, undefined);
      input.budgetTracker.markIncomplete("coverage_incomplete");
      const message = `Finding verification by ${result.agent} ${result.status}: ${
        result.error?.message ?? result.error?.code ?? "no detail"
      }`;
      warnings.push(sanitizeTextForDisplay(message));
      await input.trace.write({
        type: "verification_failed",
        traceId: input.traceId,
        agent: result.agent,
        status: result.status,
        errorCode: result.error?.code,
        timestamp: new Date().toISOString(),
      });
      continue;
    }

    const verdicts = parseVerificationVerdicts(result.rawText);
    applyVerificationVerdicts(group.targets, result.agent, verdicts);
    if (!verdicts) {
      input.budgetTracker.markIncomplete("coverage_incomplete");
      const message = `Finding verification by ${result.agent} returned malformed verdict JSON.`;
      warnings.push(message);
      await input.trace.write({
        type: "verification_failed",
        traceId: input.traceId,
        agent: result.agent,
        status: "malformed_verdicts",
        timestamp: new Date().toISOString(),
      });
    }
  }

  await input.trace.write({
    type: "verification_completed",
    traceId: input.traceId,
    counts: countVerificationStatuses(input.findings),
    timestamp: new Date().toISOString(),
  });
  return warnings;
}

function failedVerifierResult(
  agent: AgentName,
  code: "AGENT_MANAGER_FAILED" | "AGENT_RESULT_MISSING",
): AgentRunResult {
  const timestamp = new Date().toISOString();
  return {
    agent,
    role: "finding_verifier",
    status: "failed",
    startedAt: timestamp,
    completedAt: timestamp,
    error: {
      code,
      message: "The agent manager did not return a verification result.",
    },
  };
}

function buildJudgeAgentFindings(results: AgentRunResult[]): Array<{
  agent: AgentRunResult["agent"];
  role: string;
  findings: NormalizedAgentOpinion["findings"];
}> {
  return results.flatMap((result) => {
    if (!result.normalized) return [];
    return [
      {
        agent: result.agent,
        role: result.role,
        findings: result.normalized.findings.map((finding) => ({
          ...finding,
          title: sanitizeText(finding.title),
          evidence: sanitizeText(finding.evidence).slice(0, 300),
          recommendation: sanitizeText(finding.recommendation),
        })),
      },
    ];
  });
}

function buildCrossModelAnalysis(
  judge: JudgeRunResult,
  reviewMode: KyosoResult["reviewMode"],
): CrossModelAnalysis | undefined {
  if (judge.status !== "completed") return undefined;
  if (reviewMode === "single_agent") {
    return {
      blindSpots: [],
      contradictions: [],
      partialCoverage: [],
      provider: judge.provider,
    };
  }
  return {
    blindSpots: judge.output.analysis?.blindSpots ?? [],
    contradictions: judge.output.analysis?.contradictions ?? [],
    partialCoverage: judge.output.analysis?.partialCoverage ?? [],
    provider: judge.provider,
  };
}

async function runBudgetedJudge(
  input: JudgeRunInput & {
    budgetTracker: ReviewBudgetTracker;
    trace: { write(event: Record<string, unknown>): Promise<void> };
    traceId: string;
  },
): Promise<JudgeRunResult> {
  const configuredProvider = input.requestedProvider ?? input.config.provider;
  const judgeRoute = resolveJudgeCallRoute(
    input.config.mode,
    configuredProvider,
    input.env,
  );
  if (!judgeRoute.llmAvailable) {
    return runJudge(input);
  }

  const fallback = () =>
    runJudge({
      ...input,
      config: { ...input.config, mode: "deterministic_only" },
    });
  if (input.budgetTracker.snapshot().completion.status === "incomplete") {
    await recordSkippedJudgeCall(input, "review_incomplete");
    return fallback();
  }
  if (
    input.budgetTracker.budget.skipOptionalPhasesWhenTokenUsageUnknown &&
    input.budgetTracker.isTokenUsageUnknown()
  ) {
    await recordSkippedJudgeCall(input, "token_usage_unknown");
    return fallback();
  }

  const reservationResult = input.budgetTracker.reserve({ kind: "judge" });
  if ("failure" in reservationResult) {
    await recordSkippedJudgeCall(input, reservationResult.failure.reason);
    await input.trace.write({
      type: "review_budget_exhausted",
      traceId: input.traceId,
      phase: "judge",
      kind: "judge",
      reason: reservationResult.failure.reason,
      timestamp: new Date().toISOString(),
    });
    return fallback();
  }

  const reservation = reservationResult.reservation;
  await input.trace.write({
    type: "model_call_reserved",
    traceId: input.traceId,
    kind: "judge",
    timestamp: new Date().toISOString(),
  });
  const timeoutMs = Math.min(
    input.config.timeoutMs,
    input.budgetTracker.remainingWallTimeMs(),
  );
  if (timeoutMs <= 0) {
    input.budgetTracker.skip(reservation, "deadline");
    await input.trace.write({
      type: "review_budget_exhausted",
      traceId: input.traceId,
      phase: "judge",
      kind: "judge",
      reason: "deadline",
      timestamp: new Date().toISOString(),
    });
    await input.trace.write({
      type: "model_call_skipped",
      traceId: input.traceId,
      kind: "judge",
      reason: "deadline",
      timestamp: new Date().toISOString(),
    });
    return fallback();
  }

  input.budgetTracker.markStarted(reservation);
  const judge = await runJudge({ ...input, timeoutMs });
  const usage = normalizeModelTokenUsage(judge.usage);
  input.budgetTracker.complete(reservation, {
    ...(usage ? { usage } : {}),
    ...(judge.executionIdentity
      ? { executionIdentity: judge.executionIdentity }
      : {}),
  });
  const executionIdentity = input.budgetTracker.executionIdentity(reservation);
  await input.trace.write({
    type: "model_call_completed",
    traceId: input.traceId,
    kind: "judge",
    provider: judge.provider,
    resultStatus: judge.status,
    ...(usage ? { usage } : {}),
    ...(executionIdentity ? { executionIdentity } : {}),
    timestamp: new Date().toISOString(),
  });
  return judge;
}

async function recordSkippedJudgeCall(
  input: Pick<
    JudgeRunInput & {
      budgetTracker: ReviewBudgetTracker;
      trace: { write(event: Record<string, unknown>): Promise<void> };
      traceId: string;
    },
    "budgetTracker" | "trace" | "traceId"
  >,
  reason: string,
): Promise<void> {
  input.budgetTracker.recordSkipped({ kind: "judge", reason });
  await input.trace.write({
    type: "model_call_skipped",
    traceId: input.traceId,
    kind: "judge",
    reason,
    timestamp: new Date().toISOString(),
  });
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
  warnings: string[];
  budgetTracker: ReviewBudgetTracker;
}): Promise<AgentRunResult[]> {
  const agentRoles = resolveAgentRoles(input.config);
  const enabledAgents = (["codex", "claude"] as const).filter(
    (agent) => input.config.agents[agent].enabled,
  );
  const openRouter = input.config.agents.codex.openRouter;
  const hasOpenRouterRetryPolicy = Object.values(openRouter).some(
    (value) => value !== undefined,
  );
  if (
    enabledAgents.includes("codex") &&
    input.config.agents.codex.provider === CODEX_OPENROUTER_PROVIDER &&
    hasOpenRouterRetryPolicy
  ) {
    await input.trace.write({
      type: "openrouter_retry_policy_resolved",
      traceId: input.traceId,
      streamIdleTimeoutMs: openRouter.streamIdleTimeoutMs,
      streamMaxRetries: openRouter.streamMaxRetries,
      requestMaxRetries: openRouter.requestMaxRetries,
      source: "kyoso_config",
      timestamp: new Date().toISOString(),
    });
  }
  if (enabledAgents.length === 0) return [];

  const reservationResult = input.budgetTracker.reserveMany(
    enabledAgents.map((agent) => ({ kind: "primary" as const, agent })),
  );
  if ("failure" in reservationResult) {
    input.budgetTracker.markIncomplete(reservationResult.failure.reason);
    input.budgetTracker.markIncomplete("coverage_incomplete");
    await input.trace.write({
      type: "review_budget_exhausted",
      traceId: input.traceId,
      phase: "primary",
      reason: reservationResult.failure.reason,
      requiredCalls: enabledAgents.length,
      timestamp: new Date().toISOString(),
    });
    for (const agent of enabledAgents) {
      input.budgetTracker.recordSkipped({
        kind: "primary",
        agent,
        reason: reservationResult.failure.reason,
      });
      await input.trace.write({
        type: "model_call_skipped",
        traceId: input.traceId,
        kind: "primary",
        agent,
        reason: reservationResult.failure.reason,
        timestamp: new Date().toISOString(),
      });
    }
    return enabledAgents.map((agent) => {
      const role = agentRoles[agent] ?? input.config.agents[agent].role;
      const timestamp = new Date().toISOString();
      return {
        agent,
        role,
        status: "skipped",
        startedAt: timestamp,
        completedAt: timestamp,
        error: {
          code:
            reservationResult.failure.reason === "deadline"
              ? "REVIEW_DEADLINE_EXCEEDED"
              : "MODEL_CALL_BUDGET_EXHAUSTED",
          message:
            reservationResult.failure.reason === "deadline"
              ? "Review deadline was reached before primary agents could start."
              : "The review model-call budget cannot reserve all primary agents.",
        },
      };
    });
  }

  const reservations = new Map(
    reservationResult.reservations.map((reservation) => [
      reservation.agent,
      reservation,
    ]),
  );
  for (const reservation of reservationResult.reservations) {
    await input.trace.write({
      type: "model_call_reserved",
      traceId: input.traceId,
      kind: reservation.kind,
      agent: reservation.agent,
      timestamp: new Date().toISOString(),
    });
  }

  if (input.budgetTracker.remainingWallTimeMs() <= 0) {
    input.budgetTracker.markIncomplete("deadline");
    input.budgetTracker.markIncomplete("coverage_incomplete");
    await input.trace.write({
      type: "review_budget_exhausted",
      traceId: input.traceId,
      phase: "primary",
      reason: "deadline",
      timestamp: new Date().toISOString(),
    });
    return await skipReservedPrimaryAgents({
      trace: input.trace,
      traceId: input.traceId,
      budgetTracker: input.budgetTracker,
      config: input.config,
      agents: enabledAgents,
      agentRoles,
      reservations,
      reason: "deadline",
    });
  }

  const startedWrites: Promise<void>[] = [];
  let acceptingStartedEvents = true;
  const requiredLenses = resolveRequiredLenses(
    input.request,
    input.config.reviewPolicy.additionalLenses,
  );
  const agentInputs = enabledAgents.map((agent) => {
    const agentConfig = input.config.agents[agent];
    const role = agentRoles[agent] ?? agentConfig.role;
    const reservation = reservations.get(agent);
    if (!reservation) {
      throw new Error(`Missing primary budget reservation for ${agent}.`);
    }
    return {
      traceId: input.traceId,
      agent,
      role,
      tool: input.tool,
      prompt: buildAgentPrompt(input.tool, input.request, agent, role, {
        requiredLenses,
        cisaEnabled: input.config.securityReview.cisaSecureByDesign.enabled,
        maxFindingsTarget: input.budgetTracker.budget.maxFindingsPerAgent,
      }),
      workspaceDir: input.workspaceDir,
      timeoutMs: Math.min(
        input.request.options?.maxAgentTimeoutMs ?? Number.POSITIVE_INFINITY,
        agentConfig.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
        input.budgetTracker.remainingWallTimeMs(),
      ),
      deadlineAtEpochMs: input.budgetTracker.deadlineAtEpochMs,
      warnOutputBytes: input.budgetTracker.budget.effectiveWarnAgentOutputBytes,
      maxOutputBytes: input.budgetTracker.budget.maxAgentOutputBytes,
      networkMode: input.networkMode,
      onStarted: (executionIdentity?: ModelExecutionIdentity) => {
        input.budgetTracker.markStarted(reservation, executionIdentity);
        if (!acceptingStartedEvents) return Promise.resolve();
        const event = buildAgentStartedEvent({
          traceId: input.traceId,
          agent,
          role,
          executionIdentity: input.budgetTracker.executionIdentity(reservation),
        });
        const write = (async () => {
          try {
            await input.trace.write(event);
          } catch {
            input.warnings.push(
              "AUDIT_WRITE_FAILED: agent_started event could not be recorded.",
            );
          }
        })();
        startedWrites.push(write);
        return write;
      },
    };
  });

  let results: AgentRunResult[];
  try {
    results = await input.manager.runAll(agentInputs);
  } catch (error) {
    const detail = sanitizeTextForDisplay(
      error instanceof Error ? error.message : String(error),
    );
    input.warnings.push(`Primary-agent execution failed: ${detail}`);
    results = agentInputs.map((agentInput) => ({
      agent: agentInput.agent,
      role: agentInput.role,
      status: "failed" as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: {
        code: "AGENT_MANAGER_FAILED",
        message: "The agent manager did not return a review result.",
      },
    }));
  }
  acceptingStartedEvents = false;
  await Promise.all(startedWrites);

  const resultByAgent = new Map(
    results.map((result) => [result.agent, result]),
  );
  const orderedResults = enabledAgents.map((agent) => {
    const existing = resultByAgent.get(agent);
    if (existing) return existing;
    const role = agentRoles[agent] ?? input.config.agents[agent].role;
    const timestamp = new Date().toISOString();
    return {
      agent,
      role,
      status: "failed" as const,
      startedAt: timestamp,
      completedAt: timestamp,
      error: {
        code: "AGENT_RESULT_MISSING",
        message: "The agent manager did not return a review result.",
      },
    };
  });

  const normalizedResults = orderedResults.map((result) =>
    normalizeAgentRunResult(
      result,
      input.budgetTracker.budget.maxFindingsPerAgent,
    ),
  );

  for (const result of normalizedResults) {
    const reservation = reservations.get(result.agent);
    if (!reservation) continue;
    await finalizeModelCallResult({
      budgetTracker: input.budgetTracker,
      reservation,
      result,
      trace: input.trace,
      traceId: input.traceId,
    });
    if (result.status !== "completed") {
      input.budgetTracker.markIncomplete("coverage_incomplete");
    }
  }
  await Promise.all(
    normalizedResults.map((result) => {
      const event: Record<string, unknown> = {
        type: "agent_completed",
        traceId: input.traceId,
        agent: result.agent,
        role: result.role,
        status: result.status,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        timestamp: new Date().toISOString(),
      };
      if (result.error) {
        event.errorCode = result.error.code;
        event.errorDetail = result.error.detail;
      }
      if (result.salvaged !== undefined) event.salvaged = result.salvaged;
      if (result.reportedFindings !== undefined) {
        event.reportedFindings = result.reportedFindings;
      }
      if (result.findingsTargetExceeded !== undefined) {
        event.findingsTargetExceeded = result.findingsTargetExceeded;
      }
      if (input.config.audit.includeRawAgentOutput && result.rawText) {
        event.rawText = sanitizeTextForRawOutput(result.rawText);
      }
      return input.trace.write(event);
    }),
  );
  return normalizedResults;
}

async function skipReservedPrimaryAgents(input: {
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
  budgetTracker: ReviewBudgetTracker;
  config: KyosoConfig;
  agents: AgentName[];
  agentRoles: Partial<Record<AgentName, AgentRole>>;
  reservations: Map<AgentName | undefined, ModelCallReservation>;
  reason: "deadline";
}): Promise<AgentRunResult[]> {
  const results: AgentRunResult[] = [];
  for (const agent of input.agents) {
    const reservation = input.reservations.get(agent);
    if (reservation) input.budgetTracker.skip(reservation, input.reason);
    await input.trace.write({
      type: "model_call_skipped",
      traceId: input.traceId,
      kind: "primary",
      agent,
      reason: input.reason,
      timestamp: new Date().toISOString(),
    });
    const timestamp = new Date().toISOString();
    results.push({
      agent,
      role: input.agentRoles[agent] ?? input.config.agents[agent].role,
      status: "skipped",
      startedAt: timestamp,
      completedAt: timestamp,
      error: {
        code: "REVIEW_DEADLINE_EXCEEDED",
        message: "Review deadline was reached before the agent could start.",
      },
    });
  }
  return results;
}

async function finalizeModelCallResult(input: {
  budgetTracker: ReviewBudgetTracker;
  reservation: ModelCallReservation;
  result: AgentRunResult;
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
}): Promise<void> {
  const reason = input.result.error?.code ?? input.result.status;
  const hasStarted = input.budgetTracker.hasStarted(input.reservation);
  const canSkip =
    input.result.status === "skipped" ||
    isPreflightAgentFailure(input.result) ||
    (!hasStarted && input.result.error?.code === "REVIEW_DEADLINE_EXCEEDED");
  if (canSkip && !hasStarted) {
    input.budgetTracker.skip(input.reservation, reason);
    if (input.result.error?.code === "REVIEW_DEADLINE_EXCEEDED") {
      input.budgetTracker.markIncomplete("deadline");
    }
    await input.trace.write({
      type: "model_call_skipped",
      traceId: input.traceId,
      kind: input.reservation.kind,
      agent: input.reservation.agent,
      reason,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  input.budgetTracker.markStarted(
    input.reservation,
    input.result.executionIdentity,
  );
  const usage = normalizeModelTokenUsage(input.result.usage);
  const { messageBytes, thoughtBytes, outputBytes } = resolveOutputByteMetrics(
    input.result,
  );
  const warningThreshold =
    input.budgetTracker.budget.effectiveWarnAgentOutputBytes;
  const warningTriggered =
    warningThreshold !== undefined &&
    outputBytes !== undefined &&
    (input.result.outputWarningTriggered === true ||
      outputBytes >= warningThreshold);
  const outputWarningTriggered =
    warningTriggered || input.result.outputWarningTriggered !== undefined
      ? warningTriggered
      : undefined;
  input.budgetTracker.complete(input.reservation, {
    ...(messageBytes === undefined ? {} : { messageBytes }),
    ...(thoughtBytes === undefined ? {} : { thoughtBytes }),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(outputWarningTriggered === undefined ? {} : { outputWarningTriggered }),
    ...(input.result.salvaged === undefined
      ? {}
      : { salvaged: input.result.salvaged }),
    ...(input.result.reportedFindings === undefined
      ? {}
      : { reportedFindings: input.result.reportedFindings }),
    ...(input.result.findingsTargetExceeded === undefined
      ? {}
      : { findingsTargetExceeded: input.result.findingsTargetExceeded }),
    ...(usage ? { usage } : {}),
    ...(input.result.executionIdentity
      ? { executionIdentity: input.result.executionIdentity }
      : {}),
    ...(input.result.stopReason ? { stopReason: input.result.stopReason } : {}),
  });
  const executionIdentity = input.budgetTracker.executionIdentity(
    input.reservation,
  );
  if (input.result.error?.code === "AGENT_OUTPUT_LIMIT") {
    input.budgetTracker.markIncomplete("agent_output_limit");
  }
  if (input.result.error?.code === "REVIEW_DEADLINE_EXCEEDED") {
    input.budgetTracker.markIncomplete("deadline");
  }
  if (
    outputWarningTriggered &&
    warningThreshold !== undefined &&
    messageBytes !== undefined &&
    thoughtBytes !== undefined &&
    outputBytes !== undefined
  ) {
    await input.trace.write({
      type: "agent_output_warning",
      traceId: input.traceId,
      kind: input.reservation.kind,
      agent: input.reservation.agent,
      thresholdBytes: warningThreshold,
      messageBytes,
      thoughtBytes,
      outputBytes,
      timestamp: new Date().toISOString(),
    });
  }
  await input.trace.write({
    type: "model_call_completed",
    traceId: input.traceId,
    kind: input.reservation.kind,
    agent: input.reservation.agent,
    resultStatus: input.result.status,
    ...(input.result.error?.code ? { errorCode: input.result.error.code } : {}),
    ...(messageBytes === undefined ? {} : { messageBytes }),
    ...(thoughtBytes === undefined ? {} : { thoughtBytes }),
    ...(outputBytes === undefined ? {} : { outputBytes }),
    ...(outputWarningTriggered === undefined ? {} : { outputWarningTriggered }),
    ...(input.result.salvaged === undefined
      ? {}
      : { salvaged: input.result.salvaged }),
    ...(input.result.reportedFindings === undefined
      ? {}
      : { reportedFindings: input.result.reportedFindings }),
    ...(input.result.findingsTargetExceeded === undefined
      ? {}
      : { findingsTargetExceeded: input.result.findingsTargetExceeded }),
    ...(usage ? { usage } : {}),
    ...(executionIdentity ? { executionIdentity } : {}),
    ...(input.result.stopReason ? { stopReason: input.result.stopReason } : {}),
    timestamp: new Date().toISOString(),
  });
}

function buildAgentStartedEvent(input: {
  traceId: string;
  agent: AgentName;
  role: AgentRole;
  executionIdentity?: ModelExecutionIdentity;
}): Record<string, unknown> {
  const executionIdentity = normalizeModelExecutionIdentity(
    input.executionIdentity,
  );
  return {
    type: "agent_started",
    traceId: input.traceId,
    agent: input.agent,
    role: input.role,
    ...(executionIdentity ? { executionIdentity } : {}),
    ...(executionIdentity?.requestedModel
      ? { model: executionIdentity.requestedModel }
      : {}),
    ...(executionIdentity?.providerRoute === "openrouter"
      ? { provider: "openrouter" }
      : {}),
    timestamp: new Date().toISOString(),
  };
}

function resolveOutputByteMetrics(result: AgentRunResult): {
  messageBytes?: number;
  thoughtBytes?: number;
  outputBytes?: number;
} {
  const rawTextBytes = result.rawText
    ? Buffer.byteLength(result.rawText, "utf8")
    : undefined;
  let messageBytes = result.messageBytes;
  let thoughtBytes = result.thoughtBytes;

  if (messageBytes === undefined && thoughtBytes === undefined) {
    if (rawTextBytes !== undefined) {
      messageBytes = rawTextBytes;
      thoughtBytes =
        result.outputBytes === undefined
          ? 0
          : Math.max(0, result.outputBytes - rawTextBytes);
    } else if (result.outputBytes !== undefined) {
      messageBytes = result.outputBytes;
      thoughtBytes = 0;
    }
  } else if (messageBytes === undefined) {
    messageBytes =
      result.outputBytes === undefined
        ? (rawTextBytes ?? 0)
        : Math.max(0, result.outputBytes - (thoughtBytes ?? 0));
  } else if (thoughtBytes === undefined) {
    thoughtBytes =
      result.outputBytes === undefined
        ? 0
        : Math.max(0, result.outputBytes - messageBytes);
  }

  return {
    ...(messageBytes === undefined ? {} : { messageBytes }),
    ...(thoughtBytes === undefined ? {} : { thoughtBytes }),
    ...(messageBytes === undefined || thoughtBytes === undefined
      ? {}
      : { outputBytes: messageBytes + thoughtBytes }),
  };
}

function isPreflightAgentFailure(result: AgentRunResult): boolean {
  return (
    result.status === "failed" &&
    [
      "AGENT_CONFIG_INVALID",
      "OPENROUTER_KEY_MISSING",
      "AGENT_SPAWN_FAILED",
      "AGENT_MANAGER_FAILED",
      "AGENT_RESULT_MISSING",
    ].includes(result.error?.code ?? "")
  );
}

function resolveAgentRoles(
  config: KyosoConfig,
): Partial<Record<AgentName, AgentRole>> {
  const enabledAgents = (["codex", "claude"] as const).filter(
    (agent) => config.agents[agent].enabled,
  );
  const singleAgentMode = enabledAgents.length === 1;
  const roles: Partial<Record<AgentName, AgentRole>> = {};
  for (const agent of enabledAgents) {
    roles[agent] = singleAgentMode
      ? "combined_reviewer"
      : config.agents[agent].role;
  }
  return roles;
}

function isReviewToolEnabled(tool: ReviewTool, config: KyosoConfig): boolean {
  if (tool === "plan_review") return config.tools.planReview;
  if (tool === "security_review") return config.tools.securityReview;
  return config.tools.diffReview;
}

function disabledReviewPolicy(
  tool: ReviewTool,
  config: KyosoConfig,
  entrypoint: RunReviewOptions["entrypoint"],
):
  | {
      warning: string;
      title: string;
      coverageReason: string;
      policyReason: string;
      recommendation: string;
    }
  | undefined {
  if (entrypoint === "cli" && !config.entrypoints.cli) {
    return {
      warning: "CLI reviews are disabled by user-global entrypoints policy.",
      title: "CLI review entrypoint disabled by user policy",
      coverageReason: "CLI entrypoint disabled before agent execution",
      policyReason: "user_global_entrypoint_disabled",
      recommendation:
        "Enable entrypoints.cli in the user-global config before retrying.",
    };
  }
  if (entrypoint === "mcp" && !config.entrypoints.mcp) {
    return {
      warning: "MCP reviews are disabled by user-global entrypoints policy.",
      title: "MCP review entrypoint disabled by user policy",
      coverageReason: "MCP entrypoint disabled before agent execution",
      policyReason: "user_global_entrypoint_disabled",
      recommendation:
        "Enable entrypoints.mcp in the user-global config before retrying.",
    };
  }
  if (!isReviewToolEnabled(tool, config)) {
    return {
      warning: `${tool} is disabled by user-global tools policy.`,
      title: "Review tool disabled by user policy",
      coverageReason: "review tool disabled before agent execution",
      policyReason: "user_global_tool_disabled",
      recommendation:
        "Enable the review tool in the user-global config before retrying.",
    };
  }
  return undefined;
}

function formatCoverageWarning(
  coverage: ReviewCoverage,
  config: KyosoConfig,
): string {
  const missingPerspectives = coverage.requiredPerspectives.filter(
    (role) => !coverage.completedPerspectives.includes(role),
  );
  const reasons = [
    ...(coverage.missingLenses.length > 0
      ? [
          `missing lenses: ${coverage.missingLenses.map((item) => item.lens).join(", ")}`,
        ]
      : []),
    ...(missingPerspectives.length > 0
      ? [`missing perspectives: ${missingPerspectives.join(", ")}`]
      : []),
    ...(config.reviewPolicy.multiAgentRequired && !coverage.independentReview
      ? ["independent multi-agent review is required"]
      : []),
  ];
  return `Review coverage is incomplete (${reasons.join("; ")}).`;
}

function defaultAgentManager(
  config: KyosoConfig,
  parentEnv: NodeJS.ProcessEnv,
): AcpAgentManager {
  if (parentEnv.KYOSO_TEST_FAKE_AGENTS === "1") {
    return new FakeAgentManager();
  }
  return new SubprocessAcpAgentManager(config, parentEnv);
}

function normalizeAgentRunResult(
  result: AgentRunResult,
  maxFindingsPerAgent: number,
): AgentRunResult {
  const normalizedResult =
    result.status === "completed" && result.rawText && !result.normalized
      ? {
          ...result,
          normalized: normalizeAgentOutput(
            result.agent,
            result.role,
            result.rawText,
          ),
        }
      : result;
  const reportedFindings = normalizedResult.normalized?.findings.length;
  return reportedFindings === undefined
    ? normalizedResult
    : {
        ...normalizedResult,
        reportedFindings,
        findingsTargetExceeded: reportedFindings > maxFindingsPerAgent,
      };
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
    ...(result.salvaged === undefined ? {} : { salvaged: result.salvaged }),
  };
  if (includeRawText && result.rawText) {
    opinion.rawText = sanitizeTextForRawOutput(result.rawText);
  }
  return opinion;
}

async function buildSecretBlockResult(input: {
  tool: ReviewTool;
  trace: TraceWriter;
  traceId: string;
  startedAt: string;
  configHash?: string;
  networkMode: "model_only" | "unrestricted";
  cisaPolicy: KyosoConfig["securityReview"]["cisaSecureByDesign"];
  additionalLenses: ReviewLens[];
  secretScan: SecretScanResult;
  warnings: string[];
  budgetTracker: ReviewBudgetTracker;
  requestFingerprint: string;
}): Promise<KyosoResult> {
  const finding = finalizePolicyFinding(
    buildSecretFinding(input.secretScan, {
      id: "KYOSO-1",
      blocked: true,
    }),
  );
  const cisa: CisaSecureByDesignResult | undefined =
    input.tool === "security_review" && input.cisaPolicy.enabled
      ? computeCisaGate([finding], [], input.cisaPolicy)
      : undefined;
  const completedAt = new Date().toISOString();
  const budget = input.budgetTracker.snapshot();
  const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
    decision: "block",
    completion: budget.completion,
    executionBudget: budget.executionBudget,
    requestFingerprint: input.requestFingerprint,
    degraded: false,
    agentsUsed: [],
    reviewMode: "multi_agent",
    coverage: unavailableReviewCoverage(
      input.secretScan.redactedRequest,
      "secret scan blocked review before agent execution",
      input.additionalLenses,
    ),
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
    openQuestions: [],
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
      modelCalls: budget.modelCalls,
    },
  };
  await writeReviewBudgetCompleted({
    trace: input.trace,
    traceId: input.traceId,
    budgetTracker: input.budgetTracker,
    requestFingerprint: input.requestFingerprint,
  });
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
  return await finalizeReviewResult({
    tool: input.tool,
    trace: input.trace,
    result: resultWithoutMarkdown,
  });
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
    disposition: options.blocked ? "gate" : "actionable",
    changeRelation: "unknown",
    evidenceQuality: "concrete",
    evidenceRefs: [],
    policyReasons: ["kyoso_policy", "secret_detected"],
    fingerprint: "",
    sourceAgents: ["kyoso_policy"],
    confidence: "high",
    cisaMapping: [
      "customer_security_outcomes",
      "secure_by_default",
      "governance",
    ],
  };
}

function finalizePolicyFinding(finding: KyosoFinding): KyosoFinding {
  return {
    ...finding,
    fingerprint:
      finding.fingerprint || findingFingerprint(finding, finding.evidenceRefs),
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
  trace: TraceWriter;
  traceId: string;
  startedAt: string;
  configHash?: string;
  networkMode: "model_only" | "unrestricted";
  cisaPolicy: KyosoConfig["securityReview"]["cisaSecureByDesign"];
  warning: string;
  finding: KyosoFinding;
  redactionsApplied: number;
  coverage: ReviewCoverage;
  budgetTracker: ReviewBudgetTracker;
  requestFingerprint: string;
}): Promise<KyosoResult> {
  const completedAt = new Date().toISOString();
  const budget = input.budgetTracker.snapshot();
  const finding = finalizePolicyFinding(input.finding);
  const resultWithoutMarkdown: Omit<KyosoResult, "summaryMarkdown"> = {
    decision: "block",
    completion: budget.completion,
    executionBudget: budget.executionBudget,
    requestFingerprint: input.requestFingerprint,
    degraded: false,
    agentsUsed: [],
    reviewMode: "multi_agent",
    coverage: input.coverage,
    findings: [finding],
    cisaSecureByDesign:
      input.tool === "security_review" && input.cisaPolicy.enabled
        ? computeCisaGate([finding], [], input.cisaPolicy)
        : undefined,
    disagreements: [],
    testsToAdd:
      input.tool === "security_review"
        ? ["Add coverage for this Kyoso policy block path."]
        : [],
    residualRisks: input.tool === "security_review" ? [input.warning] : [],
    openQuestions: [],
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
      modelCalls: budget.modelCalls,
    },
  };
  await writeReviewBudgetCompleted({
    trace: input.trace,
    traceId: input.traceId,
    budgetTracker: input.budgetTracker,
    requestFingerprint: input.requestFingerprint,
  });
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
  return await finalizeReviewResult({
    tool: input.tool,
    trace: input.trace,
    result: resultWithoutMarkdown,
  });
}

async function finalizeReviewResult(input: {
  tool: ReviewTool;
  trace: TraceWriter;
  result: Omit<KyosoResult, "summaryMarkdown">;
  summaryText?: string;
}): Promise<KyosoResult> {
  await input.trace.finalize();
  const result: Omit<KyosoResult, "summaryMarkdown"> = {
    ...input.result,
    audit: {
      ...input.result.audit,
      warnings: Array.from(
        new Set([
          ...(input.result.audit.warnings ?? []),
          ...input.trace.warnings,
        ]),
      ),
    },
  };
  return {
    ...result,
    summaryMarkdown: renderMarkdownResult(input.tool, result, {
      summaryText: input.summaryText,
    }),
  };
}

async function writeReviewBudgetPlanned(input: {
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
  budgetTracker: ReviewBudgetTracker;
  requestFingerprint: string;
}): Promise<void> {
  const snapshot = input.budgetTracker.snapshot();
  await input.trace.write({
    type: "review_budget_planned",
    traceId: input.traceId,
    requestFingerprint: input.requestFingerprint,
    maxModelCalls: snapshot.executionBudget.maxModelCalls,
    maxTotalWallTimeMs: snapshot.executionBudget.wallTime.limitMs,
    ...(snapshot.executionBudget.effectiveWarnAgentOutputBytes !== undefined
      ? {
          effectiveWarnAgentOutputBytes:
            snapshot.executionBudget.effectiveWarnAgentOutputBytes,
        }
      : {}),
    maxAgentOutputBytes: snapshot.executionBudget.maxAgentOutputBytes,
    maxFindingsPerAgent: snapshot.executionBudget.maxFindingsPerAgent,
    skipOptionalPhasesWhenTokenUsageUnknown:
      snapshot.executionBudget.skipOptionalPhasesWhenTokenUsageUnknown,
    ...snapshot.executionBudget.modelCallPlan,
    timestamp: new Date().toISOString(),
  });
}

function plannedBudgetWarnings(budgetTracker: ReviewBudgetTracker): string[] {
  const fallbackCalls = budgetTracker.modelCallPlan.ceilingEffects
    .filter(
      (effect) =>
        effect.kind === "judge" &&
        effect.action === "deterministic_fallback" &&
        effect.reason === "model_call_budget",
    )
    .reduce((total, effect) => total + effect.calls, 0);
  if (fallbackCalls === 0) return [];
  return [
    `The potential model-call plan requires ${budgetTracker.modelCallPlan.potentialTotalCalls} calls, above maxModelCalls=${budgetTracker.budget.maxModelCalls}; ${fallbackCalls} LLM judge call(s) will use deterministic fallback if higher-priority calls consume the available capacity.`,
  ];
}

function outputWarningMessages(
  snapshot: ReturnType<ReviewBudgetTracker["snapshot"]>,
): string[] {
  const threshold = snapshot.executionBudget.effectiveWarnAgentOutputBytes;
  if (threshold === undefined) return [];
  return snapshot.modelCalls.flatMap((call) => {
    if (
      call.status !== "completed" ||
      !call.outputWarningTriggered ||
      !call.agent
    ) {
      return [];
    }
    const messageBytes = call.messageBytes ?? 0;
    const thoughtBytes = call.thoughtBytes ?? 0;
    const outputBytes = call.outputBytes ?? messageBytes + thoughtBytes;
    const outcome =
      call.stopReason === "cancelled"
        ? "the hard breaker subsequently stopped execution."
        : "execution continued.";
    return [
      `Agent ${call.agent} ${call.kind} output reached the ${threshold}-byte soft threshold (message: ${messageBytes}, thought: ${thoughtBytes}, total: ${outputBytes}); ${outcome}`,
    ];
  });
}

function tokenUsageWarningMessages(
  budgetTracker: ReviewBudgetTracker,
  snapshot: ReturnType<ReviewBudgetTracker["snapshot"]>,
): string[] {
  const unknownCalls = snapshot.executionBudget.tokenUsage.unknownCalls;
  if (
    budgetTracker.budget.skipOptionalPhasesWhenTokenUsageUnknown ||
    unknownCalls === 0
  ) {
    return [];
  }
  return [
    `Token usage was not reported for ${unknownCalls} completed call(s); budget enforcement continued using calls, wall time, and bytes.`,
  ];
}

function configuredReviewModelCallPlan(
  config: KyosoConfig,
  budget: ResolvedReviewBudget,
  env: NodeJS.ProcessEnv,
  requestedJudgeProvider?: JudgeProvider,
) {
  const judgeRoute = resolveJudgeCallRoute(
    config.judge.mode,
    requestedJudgeProvider ?? config.judge.provider,
    env,
  );
  return buildReviewModelCallPlan({
    maxModelCalls: budget.maxModelCalls,
    requiredPrimaryCalls: Object.values(config.agents).filter(
      (agent) => agent.enabled,
    ).length,
    verificationEnabled: config.verification.enabled,
    verificationMaxFindings: config.verification.maxFindings,
    llmJudgeAvailable: judgeRoute.llmAvailable,
  });
}

async function writeReviewBudgetCompleted(input: {
  trace: { write(event: Record<string, unknown>): Promise<void> };
  traceId: string;
  budgetTracker: ReviewBudgetTracker;
  requestFingerprint: string;
}): Promise<void> {
  const snapshot = input.budgetTracker.snapshot();
  await input.trace.write({
    type: "review_budget_completed",
    traceId: input.traceId,
    requestFingerprint: input.requestFingerprint,
    completion: snapshot.completion,
    modelCalls: snapshot.executionBudget.modelCalls,
    wallTime: snapshot.executionBudget.wallTime,
    tokenUsage: snapshot.executionBudget.tokenUsage,
    timestamp: new Date().toISOString(),
  });
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
