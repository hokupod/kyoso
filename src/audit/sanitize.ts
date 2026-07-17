import { sanitizeText } from "../security/sanitizeText.js";
import { normalizeModelExecutionIdentity } from "../core/modelExecutionIdentity.js";

const USAGE_METADATA_KEYS = new Set([
  "tokenUsage",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
  "skipOptionalPhasesWhenTokenUsageUnknown",
]);

export function sanitizeForAudit(
  value: unknown,
  options: { includeRawAgentOutput?: boolean } = {},
): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value))
    return value.map((item) => sanitizeForAudit(item, options));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "executionIdentity") {
        const identity = normalizeModelExecutionIdentity(nested);
        if (identity) result[key] = identity;
        continue;
      }
      if (
        /raw|content|env|credential|token|secret|password/i.test(key) &&
        !(options.includeRawAgentOutput && key === "rawText") &&
        !isUsageMetadata(key, nested)
      ) {
        continue;
      }
      result[key] = sanitizeForAudit(nested, options);
    }
    return result;
  }
  return value;
}

function isUsageMetadata(key: string, value: unknown): boolean {
  if (!USAGE_METADATA_KEYS.has(key)) return false;
  if (key === "tokenUsage") {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  if (key === "skipOptionalPhasesWhenTokenUsageUnknown") {
    return typeof value === "boolean";
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
