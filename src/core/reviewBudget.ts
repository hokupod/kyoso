import type {
  AgentName,
  ModelCallKind,
  ModelTokenUsage,
  ReviewBudget,
  ReviewBudgetRequest,
  ReviewCompletion,
  ReviewCompletionReason,
  ReviewExecutionBudget,
  ReviewModelCallAudit,
} from "./types.js";
import { KyosoRequestError } from "./errors.js";
import { normalizeModelTokenUsage } from "./tokenUsage.js";

type ReservationStatus = "reserved" | "started" | "completed" | "skipped";

type Reservation = {
  id: number;
  kind: ModelCallKind;
  agent?: AgentName;
  status: ReservationStatus;
  reason?: string;
  outputBytes?: number;
  usage?: ModelTokenUsage;
  stopReason?: string;
};

export type ModelCallReservation = Pick<Reservation, "id" | "kind" | "agent">;

export type BudgetReservationFailure = {
  reason: "model_call_budget" | "deadline";
};

const REVIEW_BUDGET_KEYS = new Set<keyof ReviewBudget>([
  "maxModelCalls",
  "maxTotalWallTimeMs",
  "maxAgentOutputBytes",
  "maxFindingsPerAgent",
  "skipOptionalPhasesWhenTokenUsageUnknown",
]);

const MODEL_CALL_KINDS: ModelCallKind[] = ["primary", "verifier", "judge"];

export function resolveReviewBudget(
  ceiling: ReviewBudget,
  requested: ReviewBudgetRequest | undefined,
): ReviewBudget {
  if (requested === undefined) return ceiling;
  if (!isRecord(requested)) {
    throw new KyosoRequestError(
      "options.reviewBudget must be an object.",
      "REVIEW_BUDGET_INVALID",
    );
  }

  for (const [key, value] of Object.entries(requested)) {
    if (!REVIEW_BUDGET_KEYS.has(key as keyof ReviewBudget)) {
      throw new KyosoRequestError(
        `options.reviewBudget.${key} is not supported.`,
        "REVIEW_BUDGET_INVALID",
      );
    }
    if (key === "skipOptionalPhasesWhenTokenUsageUnknown") {
      if (typeof value !== "boolean") {
        throw new KyosoRequestError(
          `options.reviewBudget.${key} must be a boolean.`,
          "REVIEW_BUDGET_INVALID",
        );
      }
      continue;
    }
    if (!isPositiveInteger(value)) {
      throw new KyosoRequestError(
        `options.reviewBudget.${key} must be a positive integer.`,
        "REVIEW_BUDGET_INVALID",
      );
    }
  }

  const numericKeys: Array<
    Exclude<keyof ReviewBudget, "skipOptionalPhasesWhenTokenUsageUnknown">
  > = [
    "maxModelCalls",
    "maxTotalWallTimeMs",
    "maxAgentOutputBytes",
    "maxFindingsPerAgent",
  ];
  for (const key of numericKeys) {
    const value = requested[key];
    if (value === undefined) continue;
    if (value > ceiling[key]) {
      throw new KyosoRequestError(
        `options.reviewBudget.${key} cannot exceed the user-global ceiling.`,
        "REVIEW_BUDGET_EXCEEDS_CEILING",
      );
    }
  }
  if (
    ceiling.skipOptionalPhasesWhenTokenUsageUnknown &&
    requested.skipOptionalPhasesWhenTokenUsageUnknown === false
  ) {
    throw new KyosoRequestError(
      "options.reviewBudget.skipOptionalPhasesWhenTokenUsageUnknown cannot relax the user-global ceiling.",
      "REVIEW_BUDGET_EXCEEDS_CEILING",
    );
  }

  return {
    maxModelCalls: requested.maxModelCalls ?? ceiling.maxModelCalls,
    maxTotalWallTimeMs:
      requested.maxTotalWallTimeMs ?? ceiling.maxTotalWallTimeMs,
    maxAgentOutputBytes:
      requested.maxAgentOutputBytes ?? ceiling.maxAgentOutputBytes,
    maxFindingsPerAgent:
      requested.maxFindingsPerAgent ?? ceiling.maxFindingsPerAgent,
    skipOptionalPhasesWhenTokenUsageUnknown:
      ceiling.skipOptionalPhasesWhenTokenUsageUnknown ||
      requested.skipOptionalPhasesWhenTokenUsageUnknown === true,
  };
}

export class ReviewBudgetTracker {
  readonly deadlineAtEpochMs: number;

  private readonly reservations = new Map<number, Reservation>();
  private readonly skippedCalls: ReviewModelCallAudit[] = [];
  private readonly incompleteReasons = new Set<ReviewCompletionReason>();
  private nextReservationId = 1;

  constructor(
    readonly budget: ReviewBudget,
    readonly startedAtEpochMs = Date.now(),
  ) {
    this.deadlineAtEpochMs = startedAtEpochMs + budget.maxTotalWallTimeMs;
  }

  remainingWallTimeMs(now = Date.now()): number {
    return Math.max(0, this.deadlineAtEpochMs - now);
  }

  hasDeadlineExpired(now = Date.now()): boolean {
    return this.remainingWallTimeMs(now) === 0;
  }

  reserveMany(
    inputs: Array<{ kind: ModelCallKind; agent?: AgentName }>,
  ):
    | { reservations: ModelCallReservation[] }
    | { failure: BudgetReservationFailure } {
    if (this.hasDeadlineExpired()) return { failure: { reason: "deadline" } };
    if (this.usedCapacity() + inputs.length > this.budget.maxModelCalls) {
      return { failure: { reason: "model_call_budget" } };
    }

    const reservations = inputs.map((input) => {
      const reservation: Reservation = {
        id: this.nextReservationId,
        kind: input.kind,
        ...(input.agent ? { agent: input.agent } : {}),
        status: "reserved",
      };
      this.reservations.set(reservation.id, reservation);
      this.nextReservationId += 1;
      return reservation;
    });
    return {
      reservations: reservations.map(({ id, kind, agent }) => ({
        id,
        kind,
        ...(agent ? { agent } : {}),
      })),
    };
  }

  reserve(input: {
    kind: ModelCallKind;
    agent?: AgentName;
  }):
    | { reservation: ModelCallReservation }
    | { failure: BudgetReservationFailure } {
    const result = this.reserveMany([input]);
    if ("failure" in result) return result;
    const reservation = result.reservations[0];
    if (!reservation) {
      return { failure: { reason: "model_call_budget" } };
    }
    return { reservation };
  }

  markStarted(reservation: ModelCallReservation): void {
    const current = this.reservations.get(reservation.id);
    if (!current || current.status !== "reserved") return;
    current.status = "started";
  }

  hasStarted(reservation: ModelCallReservation): boolean {
    const current = this.reservations.get(reservation.id);
    return current?.status === "started" || current?.status === "completed";
  }

  complete(
    reservation: ModelCallReservation,
    values: {
      outputBytes?: number;
      usage?: ModelTokenUsage;
      stopReason?: string;
    } = {},
  ): void {
    const current = this.reservations.get(reservation.id);
    if (
      !current ||
      current.status === "skipped" ||
      current.status === "completed"
    ) {
      return;
    }
    current.status = "completed";
    current.outputBytes = values.outputBytes;
    current.usage = normalizeModelTokenUsage(values.usage);
    current.stopReason = values.stopReason;
  }

  skip(reservation: ModelCallReservation, reason: string): void {
    const current = this.reservations.get(reservation.id);
    if (!current || current.status !== "reserved") return;
    current.status = "skipped";
    current.reason = reason;
  }

  recordSkipped(input: {
    kind: ModelCallKind;
    agent?: AgentName;
    reason: string;
  }): void {
    this.skippedCalls.push({
      kind: input.kind,
      ...(input.agent ? { agent: input.agent } : {}),
      status: "skipped",
      reason: input.reason,
    });
  }

  markIncomplete(reason: ReviewCompletionReason): void {
    this.incompleteReasons.add(reason);
  }

  isTokenUsageUnknown(): boolean {
    return Array.from(this.reservations.values()).some(
      (reservation) =>
        reservation.status === "completed" && reservation.usage === undefined,
    );
  }

  snapshot(now = Date.now()): {
    completion: ReviewCompletion;
    executionBudget: ReviewExecutionBudget;
    modelCalls: ReviewModelCallAudit[];
  } {
    const calls = this.modelCalls();
    const byKind = Object.fromEntries(
      MODEL_CALL_KINDS.map((kind) => [
        kind,
        { planned: 0, consumed: 0, skipped: 0 },
      ]),
    ) as ReviewExecutionBudget["modelCalls"]["byKind"];
    let planned = 0;
    let consumed = 0;
    let skipped = 0;
    const agentOutputBytes: Partial<Record<AgentName, number>> = {};
    const usageTotals: ModelTokenUsage = {};
    let reportedCalls = 0;
    let unknownCalls = 0;

    for (const reservation of this.reservations.values()) {
      planned += 1;
      byKind[reservation.kind].planned += 1;
      if (reservation.status === "completed") {
        consumed += 1;
        byKind[reservation.kind].consumed += 1;
        if (reservation.agent && reservation.outputBytes !== undefined) {
          agentOutputBytes[reservation.agent] =
            (agentOutputBytes[reservation.agent] ?? 0) +
            reservation.outputBytes;
        }
        if (reservation.usage) {
          reportedCalls += 1;
          addUsage(usageTotals, reservation.usage);
        } else {
          unknownCalls += 1;
        }
      }
      if (reservation.status === "skipped") {
        skipped += 1;
        byKind[reservation.kind].skipped += 1;
      }
    }
    for (const call of this.skippedCalls) {
      skipped += 1;
      byKind[call.kind].skipped += 1;
    }

    const tokenStatus =
      consumed === 0 || reportedCalls === 0
        ? "unknown"
        : unknownCalls === 0
          ? "reported"
          : "partial";
    const completionReasons = Array.from(this.incompleteReasons).sort();
    const consumedMs = Math.max(0, now - this.startedAtEpochMs);
    return {
      completion: {
        status: completionReasons.length > 0 ? "incomplete" : "complete",
        reasons: completionReasons,
        retryable: false,
      },
      executionBudget: {
        maxModelCalls: this.budget.maxModelCalls,
        modelCalls: { planned, consumed, skipped, byKind },
        wallTime: {
          limitMs: this.budget.maxTotalWallTimeMs,
          consumedMs,
          remainingMs: this.remainingWallTimeMs(now),
        },
        maxAgentOutputBytes: this.budget.maxAgentOutputBytes,
        maxFindingsPerAgent: this.budget.maxFindingsPerAgent,
        skipOptionalPhasesWhenTokenUsageUnknown:
          this.budget.skipOptionalPhasesWhenTokenUsageUnknown,
        agentOutputBytes,
        tokenUsage: {
          status: tokenStatus,
          reportedCalls,
          unknownCalls,
          totals: usageTotals,
        },
      },
      modelCalls: calls,
    };
  }

  private usedCapacity(): number {
    return Array.from(this.reservations.values()).filter(
      (reservation) =>
        reservation.status === "reserved" ||
        reservation.status === "started" ||
        reservation.status === "completed",
    ).length;
  }

  private modelCalls(): ReviewModelCallAudit[] {
    const reservations = Array.from(this.reservations.values())
      .filter(
        (reservation) =>
          reservation.status === "completed" ||
          reservation.status === "skipped",
      )
      .map((reservation): ReviewModelCallAudit => ({
        kind: reservation.kind,
        ...(reservation.agent ? { agent: reservation.agent } : {}),
        status: reservation.status === "completed" ? "completed" : "skipped",
        ...(reservation.reason ? { reason: reservation.reason } : {}),
        ...(reservation.outputBytes !== undefined
          ? { outputBytes: reservation.outputBytes }
          : {}),
        ...(reservation.usage ? { usage: reservation.usage } : {}),
        ...(reservation.stopReason
          ? { stopReason: reservation.stopReason }
          : {}),
      }));
    return [...reservations, ...this.skippedCalls];
  }
}

function addUsage(total: ModelTokenUsage, usage: ModelTokenUsage): void {
  for (const key of [
    "totalTokens",
    "inputTokens",
    "outputTokens",
    "thoughtTokens",
    "cachedReadTokens",
    "cachedWriteTokens",
  ] as const) {
    const value = usage[key];
    if (value === undefined) continue;
    total[key] = (total[key] ?? 0) + value;
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
