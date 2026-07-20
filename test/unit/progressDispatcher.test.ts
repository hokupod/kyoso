import { describe, expect, test } from "bun:test";
import {
  createProgressDispatcher,
  type ProgressDispatcher,
} from "../../src/core/progressDispatcher.js";
import type {
  ReviewPhase,
  ReviewProgressEvent,
} from "../../src/core/progress.js";

describe("progress dispatcher", () => {
  test("is a no-op without a sink", async () => {
    const dispatcher = createProgressDispatcher(undefined);

    expect(() => dispatcher.emit(reviewStarted())).not.toThrow();
    await dispatcher.flush();
  });

  test("delivers events in emission order", async () => {
    const received: ReviewProgressEvent[] = [];
    const dispatcher = createProgressDispatcher((event) => {
      received.push(event);
    });
    const phases: ReviewPhase[] = [
      "preflight",
      "context",
      "snapshot",
      "primary",
      "aggregation",
      "verification",
      "judge",
      "finalize",
    ];
    const events = Array.from({ length: 10 }, (_, index) =>
      phaseStarted(phases[index % phases.length]!),
    );

    for (const event of events) dispatcher.emit(event);
    await dispatcher.flush();

    expect(received).toEqual(events);
  });

  test("disables a throwing sink once without leaking an error", async () => {
    const disabled: string[] = [];
    let calls = 0;
    const dispatcher = createProgressDispatcher(
      () => {
        calls += 1;
        throw new Error("write failed");
      },
      { onSinkDisabled: (reason) => disabled.push(reason) },
    );

    dispatcher.emit(reviewStarted());
    await dispatcher.flush();
    expect(() => dispatcher.emit(phaseStarted("finalize"))).not.toThrow();
    await dispatcher.flush();

    expect(calls).toBe(1);
    expect(disabled).toEqual(["Progress sink threw while handling an event."]);
  });

  test("disables a hanging sink after its timeout", async () => {
    const disabled: string[] = [];
    const dispatcher = createProgressDispatcher(
      () => new Promise<void>(() => undefined),
      {
        sinkTimeoutMs: 10,
        onSinkDisabled: (reason) => disabled.push(reason),
      },
    );

    dispatcher.emit(reviewStarted());
    await dispatcher.flush(100);

    expect(disabled).toEqual(["Progress sink timed out after 10ms."]);
  });

  test("drops queued transient events before milestones when full", async () => {
    const received: ReviewProgressEvent[] = [];
    const gate = deferred<void>();
    const dispatcher = createProgressDispatcher(
      async (event) => {
        received.push(event);
        if (event.type === "review_started") await gate.promise;
      },
      { maxQueue: 2 },
    );

    dispatcher.emit(reviewStarted());
    dispatcher.emit(agentActivity(10));
    dispatcher.emit(agentWaiting(20));
    dispatcher.emit(phaseStarted("primary"));
    gate.resolve();
    await dispatcher.flush();

    expect(received.map((event) => event.type)).toEqual([
      "review_started",
      "agent_waiting",
      "phase_started",
    ]);
  });

  test("coalesces consecutive activity events from the same agent", async () => {
    const received: ReviewProgressEvent[] = [];
    const gate = deferred<void>();
    const dispatcher = createProgressDispatcher(async (event) => {
      received.push(event);
      if (event.type === "review_started") await gate.promise;
    });

    dispatcher.emit(reviewStarted());
    dispatcher.emit(agentActivity(10));
    dispatcher.emit(agentActivity(20));
    gate.resolve();
    await dispatcher.flush();

    expect(received).toEqual([reviewStarted(), agentActivity(20)]);
  });

  test("flush waits for delivery and gives up at its caller-provided limit", async () => {
    const gate = deferred<void>();
    const dispatcher = blockingDispatcher(gate);

    dispatcher.emit(reviewStarted());
    let completed = false;
    const flush = dispatcher.flush(100).then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBeFalse();

    gate.resolve();
    await flush;
    expect(completed).toBeTrue();

    const hanging = createProgressDispatcher(
      () => new Promise<void>(() => undefined),
      { sinkTimeoutMs: 100 },
    );
    hanging.emit(reviewStarted());
    await hanging.flush(1);
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

function phaseStarted(phase: ReviewPhase): ReviewProgressEvent {
  return {
    type: "phase_started",
    traceId: "trace",
    phase,
    timestamp: "2026-07-20T00:00:00.000Z",
  };
}

function agentActivity(totalOutputBytes: number): ReviewProgressEvent {
  return {
    type: "agent_activity",
    traceId: "trace",
    agent: "codex",
    activity: "message",
    totalOutputBytes,
    timestamp: "2026-07-20T00:00:00.000Z",
  };
}

function agentWaiting(sinceLastAcpUpdateMs: number): ReviewProgressEvent {
  return {
    type: "agent_waiting",
    traceId: "trace",
    agent: "codex",
    elapsedMs: sinceLastAcpUpdateMs,
    sinceLastAcpUpdateMs,
    timestamp: "2026-07-20T00:00:00.000Z",
  };
}

function blockingDispatcher(
  gate: ReturnType<typeof deferred<void>>,
): ProgressDispatcher {
  return createProgressDispatcher(async () => gate.promise);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
