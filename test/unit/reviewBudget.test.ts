import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { kyosoConfigSchema } from "../../src/config/schema.js";
import {
  canonicalJson,
  createRequestFingerprint,
  REVIEW_CONTRACT_VERSION,
} from "../../src/core/requestFingerprint.js";
import {
  resolveReviewBudget,
  ReviewBudgetTracker,
} from "../../src/core/reviewBudget.js";
import { normalizeModelTokenUsage } from "../../src/core/tokenUsage.js";
import { scanAndRedactSecrets } from "../../src/security/secretScan.js";

const budget = {
  maxModelCalls: 4,
  maxTotalWallTimeMs: 480_000,
  maxAgentOutputBytes: 65_536,
  maxFindingsPerAgent: 10,
  skipOptionalPhasesWhenTokenUsageUnknown: true,
};

describe("review budget", () => {
  test("only accepts request limits that tighten the user-global ceiling", () => {
    expect(
      resolveReviewBudget(budget, {
        maxModelCalls: 3,
        maxTotalWallTimeMs: 120_000,
        maxAgentOutputBytes: 1_024,
        maxFindingsPerAgent: 2,
      }),
    ).toEqual({
      ...budget,
      maxModelCalls: 3,
      maxTotalWallTimeMs: 120_000,
      maxAgentOutputBytes: 1_024,
      maxFindingsPerAgent: 2,
    });
    expect(() =>
      resolveReviewBudget(budget, { maxModelCalls: budget.maxModelCalls + 1 }),
    ).toThrow("cannot exceed the user-global ceiling");
    expect(() =>
      resolveReviewBudget(budget, {
        skipOptionalPhasesWhenTokenUsageUnknown: false,
      }),
    ).toThrow("cannot relax the user-global ceiling");
  });

  test("reserves primary calls atomically and records unknown usage honestly", () => {
    const tracker = new ReviewBudgetTracker({ ...budget, maxModelCalls: 2 });
    const primary = tracker.reserveMany([
      { kind: "primary", agent: "codex" },
      { kind: "primary", agent: "claude" },
    ]);
    expect("reservations" in primary).toBe(true);
    if (!("reservations" in primary)) return;

    expect(tracker.reserve({ kind: "verifier", agent: "codex" })).toEqual({
      failure: { reason: "model_call_budget" },
    });
    const [codex, claude] = primary.reservations;
    if (!codex || !claude) throw new Error("missing primary reservations");
    tracker.markStarted(codex);
    tracker.complete(codex, {
      outputBytes: 100,
      usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8 },
    });
    tracker.markStarted(claude);
    tracker.complete(claude, { outputBytes: 80 });

    const snapshot = tracker.snapshot();
    expect(snapshot.executionBudget.modelCalls).toMatchObject({
      planned: 2,
      consumed: 2,
      skipped: 0,
    });
    expect(snapshot.executionBudget.tokenUsage).toMatchObject({
      status: "partial",
      reportedCalls: 1,
      unknownCalls: 1,
      totals: { totalTokens: 20 },
    });
    expect(snapshot.executionBudget.agentOutputBytes).toEqual({
      codex: 100,
      claude: 80,
    });
  });

  test("keeps only non-negative safe integer provider usage values", () => {
    expect(
      normalizeModelTokenUsage({
        totalTokens: 20,
        inputTokens: -1,
        outputTokens: 4.5,
        thoughtTokens: Number.NaN,
        cachedReadTokens: Number.POSITIVE_INFINITY,
        cachedWriteTokens: 8,
      }),
    ).toEqual({ totalTokens: 20, cachedWriteTokens: 8 });
  });

  test("uses one canonical fingerprint after request redaction", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);
    const first = scanAndRedactSecrets({
      goal: "review",
      currentPlan: "token = sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    }).redactedRequest;
    const second = scanAndRedactSecrets({
      currentPlan: "token = sk-proj-zyxwvutsrqponmlkjihgfedcba123456",
      goal: "review",
    }).redactedRequest;
    const input = {
      tool: "plan_review" as const,
      config,
      roles: {
        codex: "implementation_reviewer" as const,
        claude: "architecture_security_reviewer" as const,
      },
      budget: config.reviewBudget,
    };

    expect(createRequestFingerprint({ ...input, request: first })).toBe(
      createRequestFingerprint({ ...input, request: second }),
    );
    expect(REVIEW_CONTRACT_VERSION).toBe("2026-07-15-v1");
  });

  test("canonicalizes object keys with locale-independent ordering", () => {
    expect(canonicalJson({ ä: 1, z: 2, a: 3, A: 4 })).toBe(
      '{"A":4,"a":3,"z":2,"ä":1}',
    );
  });
});
