import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BaseAcpAgentManager } from "../../src/acp/AcpAgentManager.js";
import { FakeAgentManager } from "../../src/acp/FakeAgentManager.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  kyosoConfigSchema,
  type KyosoConfig,
} from "../../src/config/schema.js";
import { runReview } from "../../src/core/runReview.js";
import { formatMcpResponse } from "../../src/mcp/formatMcpResponse.js";
import type {
  AgentRunInput,
  AgentRunResult,
  NormalizedAgentOpinion,
} from "../../src/core/types.js";

describe("review execution budget", () => {
  test("does not start either primary reviewer when both calls cannot be reserved", async () => {
    const manager = new FakeAgentManager();
    const events: Record<string, unknown>[] = [];

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        options: { reviewBudget: { maxModelCalls: 1 } },
      },
      {
        cwd: await tempCwd(),
        config: baseConfig(),
        agentManager: manager,
        traceWriterFactory: () => memoryTrace(events),
      },
    );

    expect(manager.calls).toHaveLength(0);
    expect(result).toMatchObject({
      decision: "block",
      completion: {
        status: "incomplete",
        reasons: ["coverage_incomplete", "model_call_budget"],
        retryable: false,
      },
    });
    expect(result.executionBudget.modelCalls).toMatchObject({
      planned: 0,
      consumed: 0,
      skipped: 2,
    });
    expect(result.executionBudget).toMatchObject({
      effectiveWarnAgentOutputBytes: 524_288,
      maxAgentOutputBytes: 1_048_576,
      modelCallPlan: {
        requiredPrimaryCalls: 2,
        potentialVerifierCalls: 0,
        potentialJudgeCalls: 0,
        potentialTotalCalls: 2,
        ceilingEffects: [
          {
            kind: "primary",
            action: "skip",
            calls: 2,
            reason: "model_call_budget",
          },
        ],
      },
    });
    expect(events.map((event) => event.type)).toContain(
      "review_budget_planned",
    );
    expect(events.map((event) => event.type)).toContain(
      "review_budget_exhausted",
    );
    expect(events.map((event) => event.type)).toContain(
      "review_budget_completed",
    );
    expect(
      events.find((event) => event.type === "review_budget_planned"),
    ).toMatchObject({
      effectiveWarnAgentOutputBytes: 524_288,
      maxAgentOutputBytes: 1_048_576,
      requiredPrimaryCalls: 2,
      potentialVerifierCalls: 0,
      potentialJudgeCalls: 0,
      potentialTotalCalls: 2,
    });
    const response = formatMcpResponse(result);
    const json = JSON.parse(response.content[1]?.text ?? "{}") as {
      completion?: unknown;
      executionBudget?: unknown;
      requestFingerprint?: unknown;
    };
    expect(json.completion).toEqual(result.completion);
    expect(json.executionBudget).toEqual(result.executionBudget);
    expect(json.requestFingerprint).toBe(result.requestFingerprint);
    expect(response.content[0]?.text).toContain("## Execution Budget");
    expect(response.content[0]?.text).toContain(
      "review coverage is incomplete",
    );
  });

  test("omits the soft warning when a request tightens the hard limit below it", async () => {
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        options: { reviewBudget: { maxAgentOutputBytes: 524_288 } },
      },
      {
        cwd: await tempCwd(),
        config: baseConfig(),
        agentManager: new FakeAgentManager(),
      },
    );

    expect(result.executionBudget.maxAgentOutputBytes).toBe(524_288);
    expect(result.executionBudget).not.toHaveProperty(
      "effectiveWarnAgentOutputBytes",
    );
  });

  test("fails closed when no primary review agents are enabled", async () => {
    const base = baseConfig();
    const config: KyosoConfig = {
      ...base,
      agents: {
        codex: { ...base.agents.codex, enabled: false },
        claude: { ...base.agents.claude, enabled: false },
      },
    };
    const manager = new FakeAgentManager();

    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      { cwd: await tempCwd(), config, agentManager: manager },
    );

    expect(manager.calls).toHaveLength(0);
    expect(result).toMatchObject({
      decision: "block",
      degraded: true,
      completion: {
        status: "incomplete",
        reasons: ["coverage_incomplete"],
        retryable: false,
      },
    });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ title: "No primary review agents enabled" }),
    );
  });

  test("uses only residual call budget for verification", async () => {
    const manager = new ScriptedBudgetManager();
    const config: KyosoConfig = {
      ...baseConfig(),
      verification: { ...baseConfig().verification, enabled: true },
    };

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        currentPlan: "Tenant boundary plan",
        options: { reviewBudget: { maxModelCalls: 3 } },
      },
      { cwd: await tempCwd(), config, agentManager: manager },
    );

    expect(manager.calls.map((input) => input.role)).toEqual([
      "implementation_reviewer",
      "architecture_security_reviewer",
      "finding_verifier",
    ]);
    expect(result.findings[0]?.verification?.status).toBe("confirmed");
    expect(result.executionBudget.modelCalls.byKind).toMatchObject({
      primary: { planned: 2, consumed: 2, skipped: 0 },
      verifier: { planned: 1, consumed: 1, skipped: 0 },
      judge: { planned: 0, consumed: 0, skipped: 0 },
    });
    expect(
      result.audit.modelCalls.every(
        (call) => call.executionIdentity === undefined,
      ),
    ).toBe(true);
    expect(result.summaryMarkdown).toContain("primary/codex: identity=unknown");
    expect(result.summaryMarkdown).toContain(
      "verifier/claude: identity=unknown",
    );
    expect(result.completion.status).toBe("complete");
  });

  test("marks unverified findings incomplete when verification cannot reserve a call", async () => {
    const manager = new ScriptedBudgetManager();
    const config: KyosoConfig = {
      ...baseConfig(),
      verification: { ...baseConfig().verification, enabled: true },
    };

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        currentPlan: "Tenant boundary plan",
        options: { reviewBudget: { maxModelCalls: 2 } },
      },
      { cwd: await tempCwd(), config, agentManager: manager },
    );

    expect(manager.calls).toHaveLength(2);
    expect(result.findings[0]?.verification).toMatchObject({
      status: "not_verified",
      note: "budget_exhausted",
    });
    expect(result).toMatchObject({
      decision: "block",
      completion: {
        status: "incomplete",
        reasons: [
          "coverage_incomplete",
          "disputed_finding",
          "model_call_budget",
        ],
        retryable: false,
      },
    });
  });

  test("skips optional verification instead of treating missing usage as zero", async () => {
    const manager = new ScriptedBudgetManager(false);
    const base = baseConfig();
    const config: KyosoConfig = {
      ...base,
      verification: { ...base.verification, enabled: true },
      reviewBudget: {
        ...base.reviewBudget,
        skipOptionalPhasesWhenTokenUsageUnknown: true,
      },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "Tenant boundary plan" },
      { cwd: await tempCwd(), config, agentManager: manager },
    );

    expect(manager.calls).toHaveLength(2);
    expect(result.findings[0]?.verification).toMatchObject({
      status: "not_verified",
      note: "token_usage_unknown",
    });
    expect(result).toMatchObject({
      decision: "block",
      completion: {
        status: "incomplete",
        reasons: [
          "coverage_incomplete",
          "disputed_finding",
          "token_usage_unknown",
        ],
        retryable: false,
      },
    });
    expect(result.executionBudget.tokenUsage.status).toBe("unknown");
    expect(result.testsToAdd).toContain("preserved primary test");
    expect(result.residualRisks).toContain("preserved primary risk");
    expect(result.openQuestions).toContain("preserved primary question");
  });

  test("continues optional verification by default when token usage is unknown", async () => {
    const manager = new ScriptedBudgetManager(false);
    const base = baseConfig();
    const config: KyosoConfig = {
      ...base,
      verification: { ...base.verification, enabled: true },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "Tenant boundary plan" },
      { cwd: await tempCwd(), config, agentManager: manager },
    );

    expect(manager.calls.map((input) => input.role)).toEqual([
      "implementation_reviewer",
      "architecture_security_reviewer",
      "finding_verifier",
    ]);
    expect(result.findings[0]?.verification?.status).toBe("confirmed");
    expect(result.completion.status).toBe("complete");
    expect(result.completion.reasons).not.toContain("token_usage_unknown");
    expect(result.executionBudget.tokenUsage).toMatchObject({
      status: "unknown",
      reportedCalls: 0,
      unknownCalls: 3,
    });
    expect(result.audit.warnings).toContain(
      "Token usage was not reported for 3 completed call(s); budget enforcement continued using calls, wall time, and bytes.",
    );
  });

  test("records a soft output warning without changing completion or decision", async () => {
    const events: Record<string, unknown>[] = [];
    const base = baseConfig();
    const config: KyosoConfig = {
      ...base,
      reviewBudget: {
        ...base.reviewBudget,
        warnAgentOutputBytes: 4,
        maxAgentOutputBytes: 10,
      },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd: await tempCwd(),
        config,
        agentManager: new OutputWarningManager(),
        traceWriterFactory: () => memoryTrace(events),
      },
    );

    expect(result.completion.status).toBe("complete");
    expect(result.decision).not.toBe("block");
    expect(result.audit.warnings).toContain(
      "Agent codex primary output reached the 4-byte soft threshold (message: 3, thought: 2, total: 5); execution continued.",
    );
    expect(result.audit.modelCalls).toContainEqual(
      expect.objectContaining({
        kind: "primary",
        agent: "codex",
        messageBytes: 3,
        thoughtBytes: 2,
        outputBytes: 5,
        outputWarningTriggered: true,
      }),
    );
    const warningIndex = events.findIndex(
      (event) =>
        event.type === "agent_output_warning" && event.agent === "codex",
    );
    const completedIndex = events.findIndex(
      (event) =>
        event.type === "model_call_completed" && event.agent === "codex",
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(completedIndex);
    expect(result.summaryMarkdown).toContain(
      "Agent output limits: 4 bytes soft / 10 bytes hard",
    );
    expect(result.summaryMarkdown).toContain(
      "Codex: 5 bytes (message: 3, thought: 2)",
    );
  });

  test("retains findings above the per-agent soft target", async () => {
    const manager = new FindingsTargetManager();
    const base = baseConfig();
    const currentPlan = manager.labels.join("\n");

    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan },
      { cwd: await tempCwd(), config: base, agentManager: manager },
    );

    expect(result.findings).toHaveLength(11);
    expect(result.completion.status).toBe("complete");
    expect(result.decision).not.toBe("block");
    expect(result.audit.warnings).toContain(
      "Agent codex reported 11 findings, above the soft target of 10; all findings were retained.",
    );
    expect(result.audit.modelCalls).toContainEqual(
      expect.objectContaining({
        kind: "primary",
        agent: "codex",
        reportedFindings: 11,
        findingsTargetExceeded: true,
      }),
    );
    expect(manager.calls[0]?.prompt).toContain(
      "aim for at most 10 findings in severity order",
    );
  });

  test("stops before agent launch when the review-wide deadline has elapsed", async () => {
    const manager = new FakeAgentManager();

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        options: { reviewBudget: { maxTotalWallTimeMs: 1 } },
      },
      { cwd: await tempCwd(), config: baseConfig(), agentManager: manager },
    );

    expect(manager.calls).toHaveLength(0);
    expect(result).toMatchObject({
      decision: "block",
      completion: {
        status: "incomplete",
        reasons: ["coverage_incomplete", "deadline"],
        retryable: false,
      },
    });
  });

  test("accounts for an unstarted deadline result as a skipped model call", async () => {
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd: await tempCwd(),
        config: baseConfig(),
        agentManager: new DeadlineBeforeStartManager(),
      },
    );

    expect(result).toMatchObject({
      decision: "block",
      completion: {
        status: "incomplete",
        reasons: ["coverage_incomplete", "deadline"],
        retryable: false,
      },
    });
    expect(result.executionBudget.modelCalls.byKind.primary).toEqual({
      planned: 2,
      consumed: 0,
      skipped: 2,
    });
    expect(result.audit.modelCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "primary",
          status: "skipped",
          reason: "REVIEW_DEADLINE_EXCEEDED",
        }),
      ]),
    );
  });

  test("falls back deterministically when the judge has no remaining call budget", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("judge should not be called");
    }) as unknown as typeof fetch;
    try {
      const config: KyosoConfig = {
        ...baseConfig(),
        judge: {
          ...baseConfig().judge,
          mode: "deterministic_plus_llm",
          provider: "openai",
        },
      };
      const result = await runReview(
        "plan_review",
        {
          goal: "review plan",
          options: { reviewBudget: { maxModelCalls: 2 } },
        },
        {
          cwd: await tempCwd(),
          config,
          agentManager: new FakeAgentManager(),
          env: { OPENAI_API_KEY: "test-key" },
        },
      );

      expect(fetchCalls).toBe(0);
      expect(result.completion.status).toBe("complete");
      expect(result.executionBudget.modelCalls.byKind.judge).toEqual({
        planned: 0,
        consumed: 0,
        skipped: 1,
      });
      expect(result.audit.modelCalls).toContainEqual({
        kind: "judge",
        status: "skipped",
        reason: "model_call_budget",
      });
      expect(result.audit.warnings).toContain(
        "The potential model-call plan requires 3 calls, above maxModelCalls=2; 1 LLM judge call(s) will use deterministic fallback if higher-priority calls consume the available capacity.",
      );
      expect(result.executionBudget.modelCallPlan).toEqual({
        requiredPrimaryCalls: 2,
        potentialVerifierCalls: 0,
        potentialJudgeCalls: 1,
        potentialTotalCalls: 3,
        ceilingEffects: [
          {
            kind: "judge",
            action: "deterministic_fallback",
            calls: 1,
            reason: "model_call_budget",
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does not reserve an explicit LLM judge without its credential", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("credentialless judge should not be called");
    }) as unknown as typeof fetch;
    try {
      const base = baseConfig();
      const events: Record<string, unknown>[] = [];
      const result = await runReview(
        "plan_review",
        { goal: "review plan" },
        {
          cwd: await tempCwd(),
          config: {
            ...base,
            judge: {
              ...base.judge,
              mode: "deterministic_plus_llm",
              provider: "openai",
            },
          },
          agentManager: new FakeAgentManager(),
          env: {},
          traceWriterFactory: () => memoryTrace(events),
        },
      );

      expect(fetchCalls).toBe(0);
      expect(result.executionBudget.modelCallPlan).toMatchObject({
        potentialJudgeCalls: 0,
        potentialTotalCalls: 2,
      });
      expect(result.executionBudget.modelCalls.byKind.judge).toEqual({
        planned: 0,
        consumed: 0,
        skipped: 0,
      });
      expect(
        result.audit.modelCalls.some((call) => call.kind === "judge"),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.kind === "judge" &&
            ["model_call_reserved", "model_call_completed"].includes(
              String(event.type),
            ),
        ),
      ).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("drops invalid token usage returned by an OpenAI-compatible judge", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summaryText: "Judge summary",
                  disagreementComments: [],
                }),
              },
            },
          ],
          usage: {
            total_tokens: -1,
            prompt_tokens: -2,
            completion_tokens: 4.5,
            prompt_tokens_details: { cached_tokens: 3 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const base = baseConfig();
      const result = await runReview(
        "plan_review",
        { goal: "review plan" },
        {
          cwd: await tempCwd(),
          config: {
            ...base,
            judge: {
              ...base.judge,
              mode: "deterministic_plus_llm",
              provider: "openai",
            },
          },
          agentManager: new FakeAgentManager(),
          env: { OPENAI_API_KEY: "test-key" },
        },
      );

      expect(result.executionBudget.modelCalls.byKind.judge).toEqual({
        planned: 1,
        consumed: 1,
        skipped: 0,
      });
      expect(result.executionBudget.tokenUsage.totals).toEqual({
        totalTokens: 40,
        inputTokens: 24,
        outputTokens: 16,
        cachedReadTokens: 3,
      });
      expect(
        result.audit.modelCalls.find((call) => call.kind === "judge"),
      ).toMatchObject({ usage: { cachedReadTokens: 3 } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

class ScriptedBudgetManager extends BaseAcpAgentManager {
  readonly calls: AgentRunInput[] = [];

  constructor(private readonly includeUsage = true) {
    super();
  }

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    await input.onStarted?.();
    const startedAt = new Date().toISOString();
    if (input.role === "finding_verifier") {
      return {
        agent: input.agent,
        role: input.role,
        status: "completed",
        rawText: JSON.stringify({
          verdicts: [
            {
              findingId: "KYOSO-1",
              verdict: "confirmed",
              reasoning: "reproduced",
              evidence: "test evidence",
            },
          ],
        }),
        ...(this.includeUsage ? { usage: usage() } : {}),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
    const opinion: Omit<NormalizedAgentOpinion, "agent" | "role"> = {
      summary: `${input.agent} scripted review`,
      findings:
        input.agent === "codex"
          ? [
              {
                severity: "high",
                category: "authz",
                title: "Tenant boundary bypass",
                evidence: "tenant id is trusted from input",
                recommendation: "derive tenant from session",
                changeRelation: "introduced",
                evidenceRefs: [
                  { kind: "plan_clause", label: "Tenant boundary plan" },
                ],
                confidence: "medium",
              },
            ]
          : [],
      testsToAdd: input.agent === "codex" ? ["preserved primary test"] : [],
      residualRisks: input.agent === "codex" ? ["preserved primary risk"] : [],
      openQuestions:
        input.agent === "codex" ? ["preserved primary question"] : [],
    };
    return {
      agent: input.agent,
      role: input.role,
      status: "completed",
      rawText: JSON.stringify(opinion),
      ...(this.includeUsage ? { usage: usage() } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

class OutputWarningManager extends BaseAcpAgentManager {
  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    await input.onStarted?.();
    const startedAt = new Date().toISOString();
    return {
      agent: input.agent,
      role: input.role,
      status: "completed",
      rawText: JSON.stringify({
        summary: `${input.agent} output warning test`,
        findings: [],
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
      }),
      messageBytes: input.agent === "codex" ? 3 : 2,
      thoughtBytes: input.agent === "codex" ? 2 : 0,
      outputBytes: input.agent === "codex" ? 5 : 2,
      outputWarningTriggered: input.agent === "codex",
      usage: usage(),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

class FindingsTargetManager extends BaseAcpAgentManager {
  readonly calls: AgentRunInput[] = [];
  readonly labels = [
    "Alpha clause",
    "Bravo clause",
    "Charlie clause",
    "Delta clause",
    "Echo clause",
    "Foxtrot clause",
    "Golf clause",
    "Hotel clause",
    "India clause",
    "Juliet clause",
    "Kilo clause",
  ];

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    await input.onStarted?.();
    const startedAt = new Date().toISOString();
    const findings =
      input.agent === "codex"
        ? this.labels.map((label) => ({
            severity: "low",
            category: "test",
            title: label.replace(" clause", ""),
            evidence: `${label} has a concrete regression gap`,
            recommendation: `add coverage for ${label}`,
            changeRelation: "introduced",
            evidenceQuality: "concrete",
            evidenceRefs: [{ kind: "plan_clause", label }],
            confidence: "high",
          }))
        : [];
    return {
      agent: input.agent,
      role: input.role,
      status: "completed",
      rawText: JSON.stringify({
        summary: `${input.agent} findings target test`,
        findings,
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
      }),
      usage: usage(),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

class DeadlineBeforeStartManager extends BaseAcpAgentManager {
  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    const timestamp = new Date().toISOString();
    return {
      agent: input.agent,
      role: input.role,
      status: "timeout",
      startedAt: timestamp,
      completedAt: timestamp,
      error: {
        code: "REVIEW_DEADLINE_EXCEEDED",
        message: "Review deadline was reached before the agent could start.",
      },
    };
  }
}

function baseConfig(): KyosoConfig {
  return kyosoConfigSchema.parse(defaultConfig);
}

function memoryTrace(events: Record<string, unknown>[]) {
  return {
    warnings: [],
    async write(event: Record<string, unknown>) {
      events.push(event);
    },
    async finalize() {},
  };
}

function usage() {
  return { totalTokens: 20, inputTokens: 12, outputTokens: 8 };
}

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kyoso-budget-"));
}
