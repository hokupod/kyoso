import { describe, expect, test } from "bun:test";
import { KyosoCancellationError } from "../../src/core/errors.js";
import type { KyosoResult } from "../../src/core/types.js";
import { runJudge, type JudgeRunInput } from "../../src/judge/provider.js";
import { linkSignals } from "../../src/judge/signals.js";

describe("judge signals", () => {
  test("aborts when its timeout elapses", async () => {
    const linked = linkSignals(10);

    await waitForAbort(linked.signal);

    expect(linked.signal.aborted).toBe(true);
    linked.cleanup();
  });

  test("propagates an external abort immediately", async () => {
    const controller = new AbortController();
    const linked = linkSignals(5_000, controller.signal);

    controller.abort("user cancelled");
    await waitForAbort(linked.signal);

    expect(linked.signal.reason).toBe("user cancelled");
    linked.cleanup();
  });

  test("handles an already-aborted external signal", () => {
    const controller = new AbortController();
    controller.abort("cancelled before judge");

    const linked = linkSignals(5_000, controller.signal);

    expect(linked.signal.aborted).toBe(true);
    expect(linked.signal.reason).toBe("cancelled before judge");
    linked.cleanup();
  });

  test("removes the external abort listener during cleanup", () => {
    const controller = new AbortController();
    const linked = linkSignals(5_000, controller.signal);

    linked.cleanup();
    controller.abort("late cancellation");

    expect(linked.signal.aborted).toBe(false);
  });

  test("does not turn caller cancellation into deterministic fallback", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    globalThis.fetch = ((_input, init) => {
      markFetchStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }) as typeof fetch;

    try {
      const judge = runJudge(judgeInput({ signal: controller.signal }));
      await fetchStarted;
      controller.abort("user cancelled");

      await expect(judge).rejects.toBeInstanceOf(KyosoCancellationError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const provider of ["openai", "anthropic"] as const) {
    test(`keeps ${provider} cancellation active while parsing the response body`, async () => {
      const controller = new AbortController();
      const originalFetch = globalThis.fetch;
      let markBodyStarted!: () => void;
      const bodyStarted = new Promise<void>((resolve) => {
        markBodyStarted = resolve;
      });
      globalThis.fetch = ((_input: URL | RequestInfo, init?: RequestInit) => {
        const signal = init?.signal;
        return Promise.resolve(
          Object.assign(new Response(null, { status: 200 }), {
            json: () => {
              markBodyStarted();
              return new Promise<never>((_resolve, reject) => {
                if (signal?.aborted) {
                  reject(signal.reason);
                  return;
                }
                signal?.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
              });
            },
          }),
        );
      }) as unknown as typeof fetch;

      try {
        const judge = runJudge(
          judgeInputForProvider(provider, controller.signal),
        );
        await bodyStarted;
        controller.abort("cancel during body parsing");

        await expectCancellation(judge);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("keeps timeout failures as deterministic fallback", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      })) as typeof fetch;

    try {
      await expect(
        runJudge(judgeInput({ timeoutMs: 10 })),
      ).resolves.toMatchObject({
        provider: "openai",
        status: "failed_fallback",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function judgeInput(overrides: Partial<JudgeRunInput> = {}): JudgeRunInput {
  return {
    tool: "plan_review",
    result: judgeResult(),
    summaryText: "# Summary",
    agentFindings: [],
    config: {
      mode: "deterministic_plus_llm",
      provider: "openai",
      timeoutMs: 1_000,
    },
    env: { OPENAI_API_KEY: "test-key" },
    ...overrides,
  };
}

function judgeInputForProvider(
  provider: "openai" | "anthropic",
  signal: AbortSignal,
): JudgeRunInput {
  return judgeInput({
    config: {
      mode: "deterministic_plus_llm",
      provider,
      timeoutMs: 1_000,
    },
    env:
      provider === "openai"
        ? { OPENAI_API_KEY: "test-key" }
        : { ANTHROPIC_API_KEY: "test-key" },
    signal,
  });
}

function judgeResult(): Omit<KyosoResult, "summaryMarkdown"> {
  return {
    decision: "approve",
    completion: { status: "complete", reasons: [], retryable: false },
    executionBudget: {
      maxModelCalls: 1,
      modelCallPlan: {
        requiredPrimaryCalls: 0,
        potentialVerifierCalls: 0,
        potentialJudgeCalls: 1,
        potentialTotalCalls: 1,
        ceilingEffects: [],
      },
      modelCalls: {
        planned: 0,
        consumed: 0,
        skipped: 0,
        byKind: {
          primary: { planned: 0, consumed: 0, skipped: 0 },
          verifier: { planned: 0, consumed: 0, skipped: 0 },
          judge: { planned: 0, consumed: 0, skipped: 0 },
        },
      },
      wallTime: { limitMs: 1_000, consumedMs: 0, remainingMs: 1_000 },
      maxAgentOutputBytes: 1,
      maxFindingsPerAgent: 1,
      skipOptionalPhasesWhenTokenUsageUnknown: false,
      agentOutputBytes: {},
      tokenUsage: {
        status: "reported",
        reportedCalls: 0,
        unknownCalls: 0,
        totals: {},
      },
    },
    requestFingerprint: "test-request",
    degraded: false,
    agentsUsed: [],
    reviewMode: "single_agent",
    coverage: {
      requiredLenses: [],
      attemptedLenses: [],
      missingLenses: [],
      requiredPerspectives: [],
      completedPerspectives: [],
      independentReview: false,
    },
    findings: [],
    disagreements: [],
    testsToAdd: [],
    residualRisks: [],
    openQuestions: [],
    agentOpinions: [],
    audit: {
      traceId: "trace",
      startedAt: "2026-07-20T00:00:00.000Z",
      completedAt: "2026-07-20T00:00:01.000Z",
      agentsUsed: [],
      redactionsApplied: 0,
      networkMode: "model_only",
      workspaceMode: "temp_snapshot",
      modelCalls: [],
    },
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function expectCancellation(judge: Promise<unknown>): Promise<void> {
  let outcome: unknown = "timed out waiting for cancellation";
  await Promise.race([
    judge.then(
      () => {
        outcome = "judge completed";
      },
      (error) => {
        outcome = error;
      },
    ),
    Bun.sleep(100),
  ]);
  expect(outcome).toBeInstanceOf(KyosoCancellationError);
}
