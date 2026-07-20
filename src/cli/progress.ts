import type {
  ReviewPhase,
  ReviewProgressEvent,
  ReviewProgressSink,
} from "../core/progress.js";

export type CliProgressMode = "auto" | "plain" | "jsonl" | "off";

export function resolveCliProgressMode(
  value: string | undefined,
  stderrIsTty: boolean,
): CliProgressMode {
  const mode = value ?? "auto";
  if (mode === "auto") return stderrIsTty ? "plain" : "off";
  if (mode === "plain" || mode === "jsonl" || mode === "off") return mode;
  throw new Error(
    `Invalid --progress value "${value}". Expected auto|plain|jsonl|off.`,
  );
}

export function createCliProgressSink(
  mode: CliProgressMode,
  stderrWrite: (line: string) => void,
): ReviewProgressSink | undefined {
  if (mode === "off" || mode === "auto") return undefined;
  if (mode === "jsonl") {
    return (event) => writeSafely(stderrWrite, `${JSON.stringify(event)}\n`);
  }

  const startedAtEpochMs = Date.now();
  return (event) => {
    const elapsedMs = Math.max(0, Date.now() - startedAtEpochMs);
    writeSafely(
      stderrWrite,
      `[${formatElapsed(elapsedMs)}] ${formatPlainProgressMessage(event)}\n`,
    );
  };
}

function writeSafely(write: (line: string) => void, line: string): void {
  try {
    write(line);
  } catch {
    // The dispatcher disables a failed sink; progress must never stop a review.
  }
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatPlainProgressMessage(event: ReviewProgressEvent): string {
  switch (event.type) {
    case "review_started":
      return `Kyoso review started (${event.tool})`;
    case "phase_started":
      return phaseStartedMessage(event);
    case "phase_completed":
      return phaseCompletedMessage(event);
    case "phase_skipped":
      return `${phaseLabel(event.phase)} skipped`;
    case "agent_started":
      return event.role === "finding_verifier"
        ? `Finding verifier started: ${event.agent}`
        : `Primary reviewers started: ${event.agent}`;
    case "agent_activity":
      return `${event.agent}: received ${event.totalOutputBytes} output bytes`;
    case "agent_waiting":
      return waitingMessage(event);
    case "agent_retrying":
      return retryMessage(event);
    case "agent_completed":
      return completedMessage(event);
    case "review_completed":
      return `Review completed: ${event.decision}`;
    case "review_failed":
      return "Review failed";
    case "review_cancelled":
      return "Review cancelled";
  }
}

function phaseStartedMessage(
  event: ReviewProgressEvent & { type: "phase_started" },
): string {
  switch (event.phase) {
    case "context":
      return "Preparing context";
    case "snapshot":
      return "Creating read-only snapshot";
    case "primary":
      return "Starting primary reviewers";
    case "verification":
      return "Cross-agent verification started";
    case "judge":
      return "Cross-model judge started";
    case "finalize":
      return "Finalizing review";
    case "preflight":
      return "Checking review configuration";
    case "aggregation":
      return "Aggregating findings";
  }
}

function phaseCompletedMessage(
  event: ReviewProgressEvent & { type: "phase_completed" },
): string {
  switch (event.phase) {
    case "context":
      return "Context prepared";
    case "snapshot":
      return "Read-only snapshot created";
    case "primary":
      return "Primary reviewers completed";
    case "verification":
      return "Cross-agent verification completed";
    case "judge":
      return "Cross-model judge completed";
    case "finalize":
      return "Review finalized";
    case "preflight":
      return "Review configuration checked";
    case "aggregation":
      return "Findings aggregated";
  }
}

function phaseLabel(phase: ReviewPhase): string {
  return phase === "preflight" ? "Preflight" : phase;
}

function waitingMessage(
  event: Extract<ReviewProgressEvent, { type: "agent_waiting" }>,
): string {
  const seconds = Math.floor(event.sinceLastAcpUpdateMs / 1_000);
  const threshold =
    event.streamIdleTimeoutMs === undefined
      ? ""
      : `; stream idle retry threshold is ${Math.floor(
          event.streamIdleTimeoutMs / 1_000,
        )}s`;
  return `${event.agent}: process alive; no ACP update for ${seconds}s${threshold}`;
}

function retryMessage(
  event: Extract<ReviewProgressEvent, { type: "agent_retrying" }>,
): string {
  const attempt =
    event.maxRetries === undefined
      ? String(event.observedRetry)
      : `${event.observedRetry}/${event.maxRetries}`;
  return `${event.agent}: retrying model stream (${attempt}); discarded ${event.discardedMessageBytes} bytes of incomplete output`;
}

function completedMessage(
  event: Extract<ReviewProgressEvent, { type: "agent_completed" }>,
): string {
  if (event.observedStreamRetries === undefined) {
    return `${event.agent} ${event.status}`;
  }
  const suffix = event.observedStreamRetries === 1 ? "retry" : "retries";
  return `${event.agent} completed after ${event.observedStreamRetries} observed stream ${suffix}`;
}
