import { sanitizeText } from "../security/sanitizeText.js";

export function sanitizeForAudit(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item));
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/raw|content|env|credential|token|secret|password/i.test(key)) continue;
      result[key] = sanitizeForAudit(nested);
    }
    return result;
  }
  return value;
}
