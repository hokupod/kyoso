import { KyosoRequestError } from "./errors.js";
import type { KyosoReviewRequest } from "./types.js";
import {
  resolveTimeUnitPair,
  TimeUnitValidationError,
  type TimeUnitConstraints,
} from "../utils/timeUnits.js";

export function normalizeRequestTimeUnits(
  request: KyosoReviewRequest,
): KyosoReviewRequest {
  if (!request.options) return request;

  const options = { ...request.options };
  normalizeRequestTimeUnitField(
    options as Record<string, unknown>,
    "maxAgentTimeoutMs",
    "maxAgentTimeoutS",
    {
      milliseconds: "options.maxAgentTimeoutMs",
      seconds: "options.maxAgentTimeoutS",
    },
  );

  if (options.reviewBudget) {
    const reviewBudget = { ...options.reviewBudget };
    normalizeRequestTimeUnitField(
      reviewBudget as Record<string, unknown>,
      "maxTotalWallTimeMs",
      "maxTotalWallTimeS",
      {
        milliseconds: "options.reviewBudget.maxTotalWallTimeMs",
        seconds: "options.reviewBudget.maxTotalWallTimeS",
      },
    );
    options.reviewBudget = reviewBudget;
  }

  return { ...request, options };
}

export function resolveProgressHeartbeatMs(input: {
  progressHeartbeatMs?: unknown;
  progressHeartbeatS?: unknown;
}): number | undefined {
  if (input.progressHeartbeatS === undefined) {
    return input.progressHeartbeatMs as number | undefined;
  }
  return resolveRequestTimeUnit(
    {
      milliseconds: input.progressHeartbeatMs,
      seconds: input.progressHeartbeatS,
    },
    {
      milliseconds: "progressHeartbeatMs",
      seconds: "progressHeartbeatS",
    },
    { allowZero: true },
  )?.milliseconds;
}

function normalizeRequestTimeUnitField(
  target: Record<string, unknown>,
  millisecondsKey: string,
  secondsKey: string,
  fields: {
    milliseconds: string;
    seconds: string;
  },
): void {
  if (target[secondsKey] !== undefined) {
    const resolved = resolveRequestTimeUnit(
      {
        milliseconds: target[millisecondsKey],
        seconds: target[secondsKey],
      },
      fields,
    );
    if (resolved) target[millisecondsKey] = resolved.milliseconds;
  }
  delete target[secondsKey];
}

function resolveRequestTimeUnit(
  input: {
    milliseconds?: unknown;
    seconds?: unknown;
  },
  fields: {
    milliseconds: string;
    seconds: string;
  },
  constraints?: TimeUnitConstraints,
) {
  try {
    return resolveTimeUnitPair(input, fields, constraints);
  } catch (error) {
    if (error instanceof TimeUnitValidationError) {
      throw new KyosoRequestError(error.message, "VALIDATION_ERROR");
    }
    throw error;
  }
}
