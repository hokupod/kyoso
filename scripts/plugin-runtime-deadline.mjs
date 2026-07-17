import { existsSync } from "node:fs";

export function remainingProbeTimeoutMs(
  deadlineAtEpochMs,
  requestedTimeoutMs,
  nowEpochMs = Date.now(),
) {
  return Math.max(
    0,
    Math.min(requestedTimeoutMs, deadlineAtEpochMs - nowEpochMs),
  );
}

export function boundedProbeTimeoutMs(
  deadlineAtEpochMs,
  requestedTimeoutMs,
  nowEpochMs = Date.now(),
) {
  const remainingMs = remainingProbeTimeoutMs(
    deadlineAtEpochMs,
    requestedTimeoutMs,
    nowEpochMs,
  );
  if (remainingMs <= 0) {
    throw new Error(
      "Codex Plugin runtime probe exceeded its wall-time deadline",
    );
  }
  return remainingMs;
}

export async function waitForFileUntilDeadline(
  path,
  deadlineAtEpochMs,
  options = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const timeoutMessage =
    options.timeoutMessage ??
    `File was not written before the deadline: ${path}`;

  for (;;) {
    const sleepMs = remainingProbeTimeoutMs(deadlineAtEpochMs, pollIntervalMs);
    if (sleepMs <= 0) throw new Error(timeoutMessage);
    if (existsSync(path)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, sleepMs));
  }
}
