import { REDACTION } from "./redact.js";
import { RAW_OUTPUT_MAX_CHARS } from "../core/constants.js";

const SENSITIVE_TEXT_PATTERNS = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/g,
  /\bAKIA[0-9A-Z]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/g,
  /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}["']?/gi,
];

export function sanitizeText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTION),
    value,
  );
}

export function sanitizeTextForDisplay(value: string, maxChars = 240): string {
  const compact = sanitizeText(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function sanitizeTextForRawOutput(
  value: string,
  maxChars = RAW_OUTPUT_MAX_CHARS,
): string {
  const sanitized = sanitizeText(value);
  const limit = Math.max(0, maxChars);
  if (sanitized.length <= limit) return sanitized;
  return `${sanitized.slice(0, limit)}\n[KYOSO_TRUNCATED: ${
    sanitized.length - limit
  } chars omitted]`;
}
