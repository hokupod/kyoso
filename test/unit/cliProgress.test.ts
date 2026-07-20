import { describe, expect, test } from "bun:test";
import {
  createCliProgressSink,
  resolveCliProgressMode,
} from "../../src/cli/progress.js";
import type { ReviewProgressEvent } from "../../src/core/progress.js";

describe("CLI progress", () => {
  test("resolves auto based on stderr TTY availability", () => {
    expect(resolveCliProgressMode(undefined, true)).toBe("plain");
    expect(resolveCliProgressMode(undefined, false)).toBe("off");
  });

  test("keeps explicit plain mode when stderr is not a TTY", () => {
    expect(resolveCliProgressMode("plain", false)).toBe("plain");
  });

  test("returns no sink for off mode", () => {
    expect(createCliProgressSink("off", () => undefined)).toBeUndefined();
  });

  test("rejects an invalid progress mode", () => {
    expect(() => resolveCliProgressMode("spinner", true)).toThrow(
      'Invalid --progress value "spinner". Expected auto|plain|jsonl|off.',
    );
  });

  test("writes parseable JSONL events", () => {
    const lines: string[] = [];
    const sink = createCliProgressSink("jsonl", (line) => {
      lines.push(line);
    });

    sink?.(reviewStarted());
    sink?.(reviewCompleted());

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      reviewStarted(),
      reviewCompleted(),
    ]);
  });

  test("includes discarded byte counts in retry messages", () => {
    const lines: string[] = [];
    const sink = createCliProgressSink("plain", (line) => {
      lines.push(line);
    });

    sink?.(retrying());

    expect(lines[0]).toContain("discarded 184 bytes of incomplete output");
  });

  test("renders every event from fixed safe fields only", () => {
    const lines: string[] = [];
    const sink = createCliProgressSink("plain", (line) => {
      lines.push(line);
    });

    for (const event of allEvents()) sink?.(event);

    const output = lines.join("");
    expect(output).toContain("process alive; no ACP update for 15s");
    expect(output).toContain("stream idle retry threshold is 90s");
    expect(output).not.toContain("MODEL_TEXT_MUST_NOT_LEAK");
    expect(output).not.toContain("PROMPT_MUST_NOT_LEAK");
  });

  test("does not throw when stderr is unavailable", () => {
    const sink = createCliProgressSink("plain", () => {
      throw new Error("EPIPE");
    });

    expect(() => sink?.(reviewStarted())).not.toThrow();
  });
});

function reviewStarted(): ReviewProgressEvent {
  return {
    type: "review_started",
    traceId: "trace",
    tool: "plan_review",
    timestamp: "2026-07-20T00:00:00.000Z",
  };
}

function reviewCompleted(): ReviewProgressEvent {
  return {
    type: "review_completed",
    traceId: "trace",
    decision: "approve_with_changes",
    completionStatus: "complete",
    durationMs: 1_000,
    timestamp: "2026-07-20T00:00:01.000Z",
  };
}

function retrying(): ReviewProgressEvent {
  return {
    type: "agent_retrying",
    traceId: "trace",
    agent: "codex",
    observedRetry: 1,
    maxRetries: 3,
    reason: "PROMPT_MUST_NOT_LEAK",
    discardedMessageBytes: 184,
    timestamp: "2026-07-20T00:00:01.000Z",
  };
}

function allEvents(): ReviewProgressEvent[] {
  return [
    reviewStarted(),
    {
      type: "phase_started",
      traceId: "trace",
      phase: "context",
      timestamp: "2026-07-20T00:00:01.000Z",
    },
    {
      type: "phase_completed",
      traceId: "trace",
      phase: "context",
      durationMs: 1,
      timestamp: "2026-07-20T00:00:02.000Z",
    },
    {
      type: "phase_skipped",
      traceId: "trace",
      phase: "verification",
      reason: "PROMPT_MUST_NOT_LEAK",
      timestamp: "2026-07-20T00:00:02.000Z",
    },
    {
      type: "agent_started",
      traceId: "trace",
      agent: "codex",
      role: "combined_reviewer",
      executionIdentity: {
        providerRoute: "codex_default",
        requestedModel: "MODEL_TEXT_MUST_NOT_LEAK",
        reportingStatus: "requested_only",
      },
      timestamp: "2026-07-20T00:00:02.000Z",
    },
    {
      type: "agent_activity",
      traceId: "trace",
      agent: "codex",
      activity: "message",
      totalOutputBytes: 42,
      timestamp: "2026-07-20T00:00:03.000Z",
    },
    {
      type: "agent_waiting",
      traceId: "trace",
      agent: "codex",
      elapsedMs: 15_000,
      sinceLastAcpUpdateMs: 15_000,
      streamIdleTimeoutMs: 90_000,
      timestamp: "2026-07-20T00:00:17.000Z",
    },
    retrying(),
    {
      type: "agent_completed",
      traceId: "trace",
      agent: "codex",
      status: "completed",
      durationMs: 2_000,
      observedStreamRetries: 1,
      timestamp: "2026-07-20T00:00:04.000Z",
    },
    reviewCompleted(),
    {
      type: "review_failed",
      traceId: "trace",
      errorCode: "PROMPT_MUST_NOT_LEAK",
      timestamp: "2026-07-20T00:00:05.000Z",
    },
    {
      type: "review_cancelled",
      traceId: "trace",
      timestamp: "2026-07-20T00:00:06.000Z",
    },
  ];
}
