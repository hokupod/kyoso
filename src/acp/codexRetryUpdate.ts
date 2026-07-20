import { sanitizeTextForDisplay } from "../security/sanitizeText.js";

const RETRY_ATTEMPT_PATTERN = /Reconnecting\.\.\.\s*(\d+)\/(\d+)/;
const DISPLAY_MESSAGE_FIELDS = ["title", "text", "message", "description"];

export type CodexRetryUpdate = {
  message: string;
  attempt?: number;
  maxRetries?: number;
};

export function parseCodexRetryUpdate(
  update: unknown,
): CodexRetryUpdate | undefined {
  if (!isRecord(update) || update.sessionUpdate !== "session_info_update") {
    return undefined;
  }

  const meta = isRecord(update._meta) ? update._meta : undefined;
  const codex = meta && isRecord(meta.codex) ? meta.codex : undefined;
  const error = codex && isRecord(codex.error) ? codex.error : undefined;
  if (error?.willRetry !== true) return undefined;

  const rawMessage =
    typeof error.message === "string"
      ? error.message
      : (findDisplayMessage(update) ?? "model stream retry");
  const message = sanitizeTextForDisplay(rawMessage) || "model stream retry";
  const attemptMatch = RETRY_ATTEMPT_PATTERN.exec(message);

  return {
    message,
    ...(attemptMatch?.[1] === undefined
      ? {}
      : { attempt: Number.parseInt(attemptMatch[1], 10) }),
    ...(attemptMatch?.[2] === undefined
      ? {}
      : { maxRetries: Number.parseInt(attemptMatch[2], 10) }),
  };
}

function findDisplayMessage(
  update: Record<string, unknown>,
): string | undefined {
  for (const field of DISPLAY_MESSAGE_FIELDS) {
    const value = update[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
