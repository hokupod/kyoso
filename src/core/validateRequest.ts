import type { KyosoReviewRequest, ReviewTool } from "./types.js";
import { KyosoRequestError } from "./errors.js";
import { normalizeRelativePath } from "../context/pathPolicy.js";

export function validateReviewRequest(
  tool: ReviewTool,
  request: KyosoReviewRequest,
): void {
  if (!request.goal || request.goal.trim().length === 0) {
    throw new KyosoRequestError("goal is required", "VALIDATION_ERROR");
  }
  for (const file of request.selectedFiles ?? []) {
    normalizeRelativePath(file.path);
  }
  if (tool === "diff_review" && !request.diff?.unifiedDiff) {
    throw new KyosoRequestError(
      "diff_review requires diff.unifiedDiff in MCP/core mode",
      "DIFF_REQUIRED",
    );
  }
}
