import { describe, expect, test } from "bun:test";
import {
  configTimeUnitPairs,
  normalizeConfigTimeUnits,
} from "../../src/config/timeUnits.js";
import {
  resolveTimeUnitPair,
  secondsToMilliseconds,
  validateMilliseconds,
} from "../../src/utils/timeUnits.js";
import {
  normalizeRequestTimeUnits,
  resolveProgressHeartbeatMs,
} from "../../src/core/requestTimeUnits.js";
import type { KyosoReviewRequest } from "../../src/core/types.js";

describe("time unit conversion", () => {
  test.each([
    [90, 90_000],
    [1.5, 1_500],
    [0.001, 1],
  ])("converts %p seconds to %p milliseconds", (seconds, milliseconds) => {
    expect(secondsToMilliseconds(seconds, "timeoutS")).toBe(milliseconds);
  });

  test.each([0, -1])("rejects non-positive seconds: %p", (seconds) => {
    expect(() => secondsToMilliseconds(seconds, "timeoutS")).toThrow(
      "timeoutS",
    );
  });

  test.each([0.0001, Number.NaN, Number.POSITIVE_INFINITY, 1e20])(
    "rejects seconds that cannot become safe integer milliseconds: %p",
    (seconds) => {
      expect(() => secondsToMilliseconds(seconds, "timeoutS")).toThrow(
        "timeoutS",
      );
    },
  );

  test("enforces field-specific minimums", () => {
    expect(() =>
      secondsToMilliseconds(0.999, "streamIdleTimeoutS", {
        minimumMilliseconds: 1_000,
      }),
    ).toThrow("streamIdleTimeoutS must be at least 1000 milliseconds");
    expect(
      secondsToMilliseconds(1, "streamIdleTimeoutS", {
        minimumMilliseconds: 1_000,
      }),
    ).toBe(1_000);
  });

  test("allows zero only when explicitly configured", () => {
    expect(
      secondsToMilliseconds(0, "progressHeartbeatS", { allowZero: true }),
    ).toBe(0);
    expect(
      validateMilliseconds(0, "progressHeartbeatMs", { allowZero: true }),
    ).toBe(0);
    expect(() =>
      secondsToMilliseconds(-1, "progressHeartbeatS", { allowZero: true }),
    ).toThrow("progressHeartbeatS");
  });

  test("validates both units before preferring seconds", () => {
    expect(
      resolveTimeUnitPair(
        { milliseconds: 1_000, seconds: 2 },
        { milliseconds: "timeoutMs", seconds: "timeoutS" },
      ),
    ).toEqual({
      milliseconds: 2_000,
      source: "seconds",
      sourceField: "timeoutS",
    });
    expect(() =>
      resolveTimeUnitPair(
        { milliseconds: -1, seconds: 2 },
        { milliseconds: "timeoutMs", seconds: "timeoutS" },
      ),
    ).toThrow("timeoutMs");
    expect(() =>
      resolveTimeUnitPair(
        { milliseconds: 1_000, seconds: "2" },
        { milliseconds: "timeoutMs", seconds: "timeoutS" },
      ),
    ).toThrow("timeoutS");
  });
});

describe("config time unit normalization", () => {
  test("normalizes all config aliases to canonical milliseconds", () => {
    const input = {
      agents: {
        codex: {
          timeoutS: 1.5,
          openRouter: { streamIdleTimeoutS: 2 },
        },
        claude: { timeoutS: 3 },
      },
      judge: { timeoutS: 4 },
      verification: { timeoutS: 5 },
      reviewBudget: { maxTotalWallTimeS: 6 },
    };

    expect(configTimeUnitPairs).toHaveLength(6);
    expect(normalizeConfigTimeUnits(input)).toEqual({
      agents: {
        codex: {
          timeoutMs: 1_500,
          openRouter: { streamIdleTimeoutMs: 2_000 },
        },
        claude: { timeoutMs: 3_000 },
      },
      judge: { timeoutMs: 4_000 },
      verification: { timeoutMs: 5_000 },
      reviewBudget: { maxTotalWallTimeMs: 6_000 },
    });
    expect(input.agents.codex.timeoutS).toBe(1.5);
    expect(input.agents.codex.openRouter.streamIdleTimeoutS).toBe(2);
  });

  test("prefers seconds within one layer and validates losing milliseconds", () => {
    expect(
      normalizeConfigTimeUnits({
        agents: { claude: { timeoutMs: 1_000, timeoutS: 2 } },
      }),
    ).toEqual({
      agents: { claude: { timeoutMs: 2_000 } },
    });
    expect(() =>
      normalizeConfigTimeUnits({
        agents: { claude: { timeoutMs: -1, timeoutS: 2 } },
      }),
    ).toThrow("agents.claude.timeoutMs");
  });

  test("preserves unknown keys and does not create missing subtrees", () => {
    const input = {
      agents: { codex: { unknown: true }, claude: {} },
      unknownRoot: { timeoutS: 10 },
    };
    const normalized = normalizeConfigTimeUnits(input);

    expect(normalized).toBe(input);
    expect(normalized).toEqual(input);
    expect(input.agents.codex).not.toHaveProperty("openRouter");
  });

  test("leaves milliseconds-only layers for existing schema validation", () => {
    const input = {
      agents: { claude: { timeoutMs: -1 } },
    };

    expect(normalizeConfigTimeUnits(input)).toBe(input);
  });

  test("removes an explicitly undefined seconds alias", () => {
    const input = {
      agents: { claude: { timeoutS: undefined, unknown: true } },
    };

    expect(normalizeConfigTimeUnits(input)).toEqual({
      agents: { claude: { unknown: true } },
    });
    expect(input.agents.claude).toHaveProperty("timeoutS");
  });
});

describe("request time unit normalization", () => {
  test("canonicalizes request aliases with shallow immutable copies", () => {
    const selectedFiles = [{ path: "src/a.ts", content: "export {};" }];
    const request: KyosoReviewRequest = {
      goal: "review",
      selectedFiles,
      options: {
        maxAgentTimeoutMs: 1_000,
        maxAgentTimeoutS: 2,
        reviewBudget: {
          maxTotalWallTimeMs: 3_000,
          maxTotalWallTimeS: 4,
        },
      },
    };

    const normalized = normalizeRequestTimeUnits(request);

    expect(normalized.options?.maxAgentTimeoutMs).toBe(2_000);
    expect(normalized.options).not.toHaveProperty("maxAgentTimeoutS");
    expect(normalized.options?.reviewBudget?.maxTotalWallTimeMs).toBe(4_000);
    expect(normalized.options?.reviewBudget).not.toHaveProperty(
      "maxTotalWallTimeS",
    );
    expect(normalized.selectedFiles).toBe(selectedFiles);
    expect(request.options?.maxAgentTimeoutS).toBe(2);
    expect(request.options?.reviewBudget?.maxTotalWallTimeS).toBe(4);
  });

  test("validates losing request units", () => {
    expect(() =>
      normalizeRequestTimeUnits({
        goal: "review",
        options: { maxAgentTimeoutMs: -1, maxAgentTimeoutS: 2 },
      }),
    ).toThrow("options.maxAgentTimeoutMs");
  });

  test("leaves legacy request milliseconds untouched without seconds aliases", () => {
    const normalized = normalizeRequestTimeUnits({
      goal: "review",
      options: {
        maxAgentTimeoutMs: 0.5,
        reviewBudget: { maxTotalWallTimeMs: 0.5 },
      },
    });

    expect(normalized.options?.maxAgentTimeoutMs).toBe(0.5);
    expect(normalized.options?.reviewBudget?.maxTotalWallTimeMs).toBe(0.5);
  });

  test("converts heartbeat seconds with zero and seconds precedence", () => {
    expect(resolveProgressHeartbeatMs({ progressHeartbeatMs: 0.5 })).toBe(0.5);
    expect(resolveProgressHeartbeatMs({ progressHeartbeatMs: -1 })).toBe(-1);
    expect(resolveProgressHeartbeatMs({ progressHeartbeatS: 0 })).toBe(0);
    expect(
      resolveProgressHeartbeatMs({
        progressHeartbeatMs: 100,
        progressHeartbeatS: 0.25,
      }),
    ).toBe(250);
    expect(() =>
      resolveProgressHeartbeatMs({
        progressHeartbeatMs: -1,
        progressHeartbeatS: 1,
      }),
    ).toThrow("progressHeartbeatMs");
  });
});
