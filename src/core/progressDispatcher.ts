import type { ReviewProgressEvent, ReviewProgressSink } from "./progress.js";

const DEFAULT_SINK_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_QUEUE = 128;

type ProgressDispatcherOptions = {
  sinkTimeoutMs?: number;
  maxQueue?: number;
  onSinkDisabled?: (reason: string) => void;
};

type TransientProgressEvent = Extract<
  ReviewProgressEvent,
  { type: "agent_activity" | "agent_waiting" }
>;

export type ProgressDispatcher = {
  emit(event: ReviewProgressEvent): void;
  flush(maxWaitMs?: number): Promise<void>;
};

function isTransientEvent(
  event: ReviewProgressEvent,
): event is TransientProgressEvent {
  return event.type === "agent_activity" || event.type === "agent_waiting";
}

function isSameCoalescibleEvent(
  previous: ReviewProgressEvent | undefined,
  next: ReviewProgressEvent,
): boolean {
  if (!previous || !isTransientEvent(previous) || !isTransientEvent(next)) {
    return false;
  }
  return previous.type === next.type && previous.agent === next.agent;
}

function withoutThrowing(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Progress delivery must never affect review execution.
  }
}

export function createProgressDispatcher(
  sink: ReviewProgressSink | undefined,
  options: ProgressDispatcherOptions = {},
): ProgressDispatcher {
  if (!sink) {
    return {
      emit: () => undefined,
      flush: async () => undefined,
    };
  }

  const sinkTimeoutMs = options.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const queue: ReviewProgressEvent[] = [];
  const idleResolvers = new Set<() => void>();
  let disabled = false;
  let processing = false;

  const notifyIdle = (): void => {
    if (processing || queue.length > 0) return;
    for (const resolve of idleResolvers) resolve();
    idleResolvers.clear();
  };

  const waitForIdle = (): Promise<void> => {
    if (!processing && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.add(resolve));
  };

  const disable = (reason: string): void => {
    if (disabled) return;
    disabled = true;
    queue.length = 0;
    withoutThrowing(() => options.onSinkDisabled?.(reason));
    notifyIdle();
  };

  const deliver = async (event: ReviewProgressEvent): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const delivery = Promise.resolve().then(() => sink(event));
      const timeoutResult = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), sinkTimeoutMs);
        timeout.unref?.();
      });
      const result = await Promise.race([
        delivery.then(() => "delivered" as const),
        timeoutResult,
      ]);
      if (result === "timeout") {
        disable(`Progress sink timed out after ${sinkTimeoutMs}ms.`);
        return false;
      }
      return true;
    } catch {
      disable("Progress sink threw while handling an event.");
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const drain = async (): Promise<void> => {
    try {
      while (!disabled && queue.length > 0) {
        const event = queue.shift();
        if (!event) continue;
        if (!(await deliver(event))) break;
      }
    } finally {
      processing = false;
      if (!disabled && queue.length > 0) {
        startDrain();
      } else {
        notifyIdle();
      }
    }
  };

  const startDrain = (): void => {
    if (processing || disabled || queue.length === 0) return;
    processing = true;
    void drain();
  };

  const makeRoomForMilestone = (): boolean => {
    const transientIndex = queue.findIndex(isTransientEvent);
    if (transientIndex >= 0) {
      queue.splice(transientIndex, 1);
      return true;
    }
    if (queue.length < maxQueue) return true;
    queue.shift();
    return true;
  };

  return {
    emit(event): void {
      try {
        if (disabled) return;

        const previous = queue.at(-1);
        if (isSameCoalescibleEvent(previous, event)) {
          queue[queue.length - 1] = event;
        } else if (queue.length < maxQueue) {
          queue.push(event);
        } else if (isTransientEvent(event)) {
          return;
        } else if (makeRoomForMilestone()) {
          queue.push(event);
        }

        startDrain();
      } catch {
        // Progress delivery must never affect review execution.
      }
    },

    async flush(maxWaitMs = DEFAULT_SINK_TIMEOUT_MS): Promise<void> {
      try {
        const idle = waitForIdle();
        if (maxWaitMs <= 0) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            idle,
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, maxWaitMs);
              timeout.unref?.();
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      } catch {
        // Progress delivery must never affect review execution.
      }
    },
  };
}
