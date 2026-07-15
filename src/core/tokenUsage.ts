import type { ModelTokenUsage } from "./types.js";

const TOKEN_USAGE_KEYS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
] as const;

export function normalizeModelTokenUsage(
  usage: unknown,
): ModelTokenUsage | undefined {
  if (!isRecord(usage)) return undefined;
  const normalized: ModelTokenUsage = {};
  for (const key of TOKEN_USAGE_KEYS) {
    const value = usage[key];
    if (isTokenCount(value)) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
