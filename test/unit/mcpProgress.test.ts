import { describe, expect, test } from "bun:test";
import {
  createMcpProgressSink,
  formatMcpProgressMessage,
} from "../../src/mcp/progress.js";
import type { ReviewProgressEvent } from "../../src/core/progress.js";

describe("MCP progress", () => {
  test("does not create a sink without a progress token", () => {
    const notifications: unknown[] = [];

    expect(
      createMcpProgressSink({
        notify: async (notification) => {
          notifications.push(notification);
        },
      }),
    ).toBeUndefined();
    expect(notifications).toEqual([]);
  });

  test("sends strictly increasing progress for its own token", async () => {
    const notifications: Array<{
      method: string;
      params: {
        progressToken: string | number;
        progress: number;
        message: string;
      };
    }> = [];
    const sink = createMcpProgressSink({
      _meta: { progressToken: "tok-1" },
      notify: async (notification) => {
        notifications.push(notification);
      },
    });

    await sink?.(reviewStarted());
    await sink?.(retrying());
    await sink?.(reviewCompleted());

    expect(notifications).toEqual([
      expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "tok-1",
          progress: 1,
        }),
      }),
      expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "tok-1",
          progress: 2,
        }),
      }),
      expect.objectContaining({
        method: "notifications/progress",
        params: expect.objectContaining({
          progressToken: "tok-1",
          progress: 3,
        }),
      }),
    ]);
  });

  test("formats every event from fixed safe fields", () => {
    const messages = allEvents().map(formatMcpProgressMessage);

    expect(messages.every((message) => typeof message === "string")).toBe(true);
    expect(messages.join("\n")).toContain("retrying model stream (1/3)");
    expect(messages.join("\n")).toContain("no ACP update for 15s");
    expect(messages.join("\n")).not.toContain("MODEL_TEXT_MUST_NOT_LEAK");
    expect(messages.join("\n")).not.toContain("PROMPT_MUST_NOT_LEAK");
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

function reviewCompleted(): ReviewProgressEvent {
  return {
    type: "review_completed",
    traceId: "trace",
    decision: "approve",
    completionStatus: "complete",
    durationMs: 1_000,
    timestamp: "2026-07-20T00:00:02.000Z",
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
