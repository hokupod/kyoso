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
    expect(events.map((event) => event.type)).toContain(
      "review_budget_planned",
    );
    expect(events.map((event) => event.type)).toContain(
      "review_budget_exhausted",
    );
    expect(events.map((event) => event.type)).toContain(
      "review_budget_completed",
    );
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
        reasons: ["coverage_incomplete", "model_call_budget"],
        retryable: false,
      },
    });
  });

  test("skips optional verification instead of treating missing usage as zero", async () => {
    const manager = new ScriptedBudgetManager(false);
    const config: KyosoConfig = {
      ...baseConfig(),
      verification: { ...baseConfig().verification, enabled: true },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
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
        reasons: ["coverage_incomplete", "token_usage_unknown"],
        retryable: false,
      },
    });
    expect(result.executionBudget.tokenUsage.status).toBe("unknown");
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
                confidence: "medium",
              },
            ]
          : [],
      testsToAdd: [],
      residualRisks: [],
      openQuestions: [],
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
