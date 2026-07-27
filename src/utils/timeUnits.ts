export type TimeUnitConstraints = {
  allowZero?: boolean;
  minimumMilliseconds?: number;
};

export type ResolvedTimeUnitPair = {
  milliseconds: number;
  source: "milliseconds" | "seconds";
  sourceField: string;
};

export class TimeUnitValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}`);
    this.name = "TimeUnitValidationError";
    this.field = field;
  }
}

export function validateMilliseconds(
  value: unknown,
  field: string,
  constraints: TimeUnitConstraints = {},
): number {
  assertFiniteNumber(value, field);
  if (!Number.isSafeInteger(value)) {
    throw new TimeUnitValidationError(
      field,
      "must be a safe integer number of milliseconds.",
    );
  }
  assertMinimumMilliseconds(value, field, constraints);
  return value;
}

export function secondsToMilliseconds(
  value: unknown,
  field: string,
  constraints: TimeUnitConstraints = {},
): number {
  assertFiniteNumber(value, field);
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TimeUnitValidationError(
      field,
      "must convert to a safe integer number of milliseconds.",
    );
  }
  assertMinimumMilliseconds(milliseconds, field, constraints);
  return milliseconds;
}

export function resolveTimeUnitPair(
  input: {
    milliseconds?: unknown;
    seconds?: unknown;
  },
  fields: {
    milliseconds: string;
    seconds: string;
  },
  constraints: TimeUnitConstraints = {},
): ResolvedTimeUnitPair | undefined {
  const hasMilliseconds = input.milliseconds !== undefined;
  const hasSeconds = input.seconds !== undefined;
  if (!hasMilliseconds && !hasSeconds) return undefined;

  const milliseconds = hasMilliseconds
    ? validateMilliseconds(input.milliseconds, fields.milliseconds, constraints)
    : undefined;
  const secondsMilliseconds = hasSeconds
    ? secondsToMilliseconds(input.seconds, fields.seconds, constraints)
    : undefined;

  if (secondsMilliseconds !== undefined) {
    return {
      milliseconds: secondsMilliseconds,
      source: "seconds",
      sourceField: fields.seconds,
    };
  }
  return {
    milliseconds: milliseconds as number,
    source: "milliseconds",
    sourceField: fields.milliseconds,
  };
}

function assertFiniteNumber(
  value: unknown,
  field: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TimeUnitValidationError(field, "must be a finite number.");
  }
}

function assertMinimumMilliseconds(
  value: number,
  field: string,
  constraints: TimeUnitConstraints,
): void {
  if (constraints.allowZero && value === 0) return;
  const minimumMilliseconds = constraints.minimumMilliseconds ?? 1;
  if (value < minimumMilliseconds) {
    throw new TimeUnitValidationError(
      field,
      `must be at least ${minimumMilliseconds} milliseconds.`,
    );
  }
}
