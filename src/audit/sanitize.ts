import { sanitizeText } from "../security/sanitizeText.js";

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
      if (
        /raw|content|env|credential|token|secret|password/i.test(key) &&
        !(options.includeRawAgentOutput && key === "rawText")
      ) {
        continue;
      }
      result[key] = sanitizeForAudit(nested, options);
    }
    return result;
  }
  return value;
}
