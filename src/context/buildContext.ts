import type { KyosoReviewRequest } from "../core/types.js";
import { isAllowedPath, isDeniedPath, normalizeRelativePath } from "./pathPolicy.js";
import { truncateUtf8 } from "./truncate.js";

export type BuiltContext = {
  request: KyosoReviewRequest;
  warnings: string[];
};

export function buildContext(
  request: KyosoReviewRequest,
  options: { maxContextBytes: number; maxDiffBytes: number; denyPatterns: string[]; allowPatterns?: string[] },
): BuiltContext {
  const warnings: string[] = [];
  const normalized: KyosoReviewRequest = structuredClone(request);
  let remaining = options.maxContextBytes;

  normalized.goal = truncateContextText(normalized.goal, "Goal truncated");
  if (normalized.repoSummary) {
    normalized.repoSummary = truncateContextText(
      normalized.repoSummary,
      "Repo summary truncated",
    );
  }
  if (normalized.currentPlan) {
    normalized.currentPlan = truncateContextText(
      normalized.currentPlan,
      "Current plan truncated",
    );
  }
  if (normalized.constraints) {
    normalized.constraints = normalized.constraints.flatMap((constraint, index) => {
      const truncated = truncateContextText(constraint, `Constraint truncated: constraints[${index}]`);
      return truncated.length > 0 ? [truncated] : [];
    });
  }

  if (normalized.selectedFiles) {
    normalized.selectedFiles = normalized.selectedFiles.flatMap((file) => {
      const path = normalizeRelativePath(file.path);
      if (isDeniedPath(path, options.denyPatterns)) {
        warnings.push(`Selected file denied by workspace policy: ${path}`);
        return [];
      }
      if (!isAllowedPath(path, options.allowPatterns ?? [])) {
        warnings.push(`Selected file outside workspace allow policy: ${path}`);
        return [];
      }
      const truncated = truncateUtf8(file.content, Math.max(0, remaining));
      remaining -= truncated.bytes;
      if (truncated.truncated) warnings.push(`Selected file truncated: ${path}`);
      return [
        {
          ...file,
          path,
          content: truncated.content,
          truncated: file.truncated || truncated.truncated,
        },
      ];
    });
  }

  if (normalized.diff) {
    const truncated = truncateUtf8(normalized.diff.unifiedDiff, options.maxDiffBytes);
    if (truncated.truncated) warnings.push("Diff truncated");
    normalized.diff = {
      ...normalized.diff,
      unifiedDiff: truncated.content,
    };
  }

  return { request: normalized, warnings };

  function truncateContextText(value: string, warning: string): string {
    const truncated = truncateUtf8(value, Math.max(0, remaining));
    remaining -= truncated.bytes;
    if (truncated.truncated) warnings.push(warning);
    return truncated.content;
  }
}
