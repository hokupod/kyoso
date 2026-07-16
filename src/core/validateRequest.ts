import type { KyosoReviewRequest, ReviewTool } from "./types.js";
import { KyosoRequestError } from "./errors.js";
import { normalizeRelativePath } from "../context/pathPolicy.js";
import { isReviewLens, REVIEW_LENSES } from "./reviewPolicy.js";

export function validateReviewRequest(
  tool: ReviewTool,
  request: KyosoReviewRequest,
): void {
  if (typeof request.goal !== "string" || request.goal.trim().length === 0) {
    throw new KyosoRequestError("goal is required", "VALIDATION_ERROR");
  }
  validateReviewContract(request);
  validateSelectedFiles(request);
  if (tool === "diff_review" && !request.diff?.unifiedDiff) {
    throw new KyosoRequestError(
      "diff_review requires diff.unifiedDiff in MCP/core mode",
      "DIFF_REQUIRED",
    );
  }
}

function validateReviewContract(request: KyosoReviewRequest): void {
  const contract = request.reviewContract as unknown;
  if (contract === undefined) return;
  if (!isRecord(contract)) {
    throw new KyosoRequestError(
      "reviewContract must be an object",
      "VALIDATION_ERROR",
    );
  }
  const allowedKeys = new Set(["focus", "nonGoals", "acceptedRisks"]);
  const unknownKeys = Object.keys(contract).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new KyosoRequestError(
      `reviewContract contains unknown keys: ${unknownKeys.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  const focus = contract.focus;
  if (
    focus !== undefined &&
    (!Array.isArray(focus) ||
      focus.length > REVIEW_LENSES.length ||
      focus.some((lens) => !isReviewLens(lens)))
  ) {
    throw new KyosoRequestError(
      "reviewContract.focus contains an invalid review lens",
      "VALIDATION_ERROR",
    );
  }
  const nonGoals = contract.nonGoals;
  if (
    nonGoals !== undefined &&
    (!Array.isArray(nonGoals) ||
      nonGoals.length > 20 ||
      nonGoals.some(
        (item) =>
          typeof item !== "string" ||
          item.trim().length === 0 ||
          item.length > 500,
      ))
  ) {
    throw new KyosoRequestError(
      "reviewContract.nonGoals must contain at most 20 non-empty strings of 500 characters or fewer",
      "VALIDATION_ERROR",
    );
  }
  const acceptedRisks = contract.acceptedRisks;
  if (
    acceptedRisks !== undefined &&
    (!Array.isArray(acceptedRisks) ||
      acceptedRisks.length > 20 ||
      acceptedRisks.some(
        (risk) =>
          !isRecord(risk) ||
          typeof risk.findingFingerprint !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(risk.findingFingerprint) ||
          typeof risk.rationale !== "string" ||
          risk.rationale.trim().length === 0 ||
          risk.rationale.length > 500,
      ))
  ) {
    throw new KyosoRequestError(
      "reviewContract.acceptedRisks must contain valid finding fingerprints and bounded rationales",
      "VALIDATION_ERROR",
    );
  }
}

function validateSelectedFiles(request: KyosoReviewRequest): void {
  const selectedFiles = request.selectedFiles as unknown;
  if (selectedFiles === undefined) return;
  if (!Array.isArray(selectedFiles)) {
    throw new KyosoRequestError(
      "selectedFiles must be an array",
      "VALIDATION_ERROR",
    );
  }
  for (const file of selectedFiles) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      file.path.trim().length === 0 ||
      typeof file.content !== "string" ||
      (file.language !== undefined && typeof file.language !== "string") ||
      (file.truncated !== undefined && typeof file.truncated !== "boolean")
    ) {
      throw new KyosoRequestError(
        "selectedFiles entries require string path/content and valid optional metadata",
        "VALIDATION_ERROR",
      );
    }
    normalizeRelativePath(file.path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
