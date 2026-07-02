import type { Severity } from "../core/types.js";

const SCORE: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function compareSeverity(a: Severity, b: Severity): number {
  return SCORE[b] - SCORE[a];
}

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SCORE[a] >= SCORE[b] ? a : b;
}
