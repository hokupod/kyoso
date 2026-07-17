import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import { REDACTION } from "../security/redact.js";
import type { ModelExecutionIdentity, ModelProviderRoute } from "./types.js";

export const MODEL_EXECUTION_IDENTITY_MAX_CHARS = 160;

const MODEL_PROVIDER_ROUTES = new Set<ModelProviderRoute>([
  "codex_default",
  "claude_default",
  "openrouter",
  "openai",
  "anthropic",
]);

export function createModelExecutionIdentity(input: {
  providerRoute: ModelProviderRoute;
  requestedModel?: unknown;
  reportedProvider?: unknown;
  reportedModel?: unknown;
}): ModelExecutionIdentity {
  const requestedModel = sanitizeIdentityValue(input.requestedModel);
  const reportedProvider = sanitizeIdentityValue(input.reportedProvider);
  const reportedModel = sanitizeIdentityValue(input.reportedModel);
  const reportingStatus =
    reportedProvider !== undefined || reportedModel !== undefined
      ? "reported"
      : requestedModel !== undefined
        ? "requested_only"
        : "unknown";

  return {
    providerRoute: input.providerRoute,
    ...(requestedModel ? { requestedModel } : {}),
    ...(reportedProvider ? { reportedProvider } : {}),
    ...(reportedModel ? { reportedModel } : {}),
    reportingStatus,
  };
}

export function normalizeModelExecutionIdentity(
  value: unknown,
): ModelExecutionIdentity | undefined {
  if (!isRecord(value) || !isModelProviderRoute(value.providerRoute)) {
    return undefined;
  }
  return createModelExecutionIdentity({
    providerRoute: value.providerRoute,
    requestedModel: value.requestedModel,
    reportedProvider: value.reportedProvider,
    reportedModel: value.reportedModel,
  });
}

function sanitizeIdentityValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeTextForDisplay(
    value,
    MODEL_EXECUTION_IDENTITY_MAX_CHARS,
  );
  if (
    sanitized.includes(REDACTION) ||
    /(?:https?|wss?):\/\//i.test(sanitized) ||
    /\b(?:api[_-]?key|base[_-]?url|credential|secret|token|password)\b/i.test(
      sanitized,
    ) ||
    /[{}=]/.test(sanitized)
  ) {
    return undefined;
  }
  return sanitized.length > 0 ? sanitized : undefined;
}

function isModelProviderRoute(value: unknown): value is ModelProviderRoute {
  return (
    typeof value === "string" &&
    MODEL_PROVIDER_ROUTES.has(value as ModelProviderRoute)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
