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
  if (options.maxAgentTimeoutS !== undefined) {
    const maxAgentTimeout = resolveRequestTimeUnit(
      {
        milliseconds: options.maxAgentTimeoutMs,
        seconds: options.maxAgentTimeoutS,
      },
      {
        milliseconds: "options.maxAgentTimeoutMs",
        seconds: "options.maxAgentTimeoutS",
      },
    );
    if (maxAgentTimeout) {
      options.maxAgentTimeoutMs = maxAgentTimeout.milliseconds;
    }
  }
  delete options.maxAgentTimeoutS;

  if (options.reviewBudget) {
    const reviewBudget = { ...options.reviewBudget };
    if (reviewBudget.maxTotalWallTimeS !== undefined) {
      const maxTotalWallTime = resolveRequestTimeUnit(
        {
          milliseconds: reviewBudget.maxTotalWallTimeMs,
          seconds: reviewBudget.maxTotalWallTimeS,
        },
        {
          milliseconds: "options.reviewBudget.maxTotalWallTimeMs",
          seconds: "options.reviewBudget.maxTotalWallTimeS",
        },
      );
      if (maxTotalWallTime) {
        reviewBudget.maxTotalWallTimeMs = maxTotalWallTime.milliseconds;
      }
    }
    delete reviewBudget.maxTotalWallTimeS;
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
