import {
  resolveTimeUnitPair,
  type TimeUnitConstraints,
} from "../utils/timeUnits.js";

type ConfigTimeUnitPair = {
  parentPath: readonly string[];
  millisecondsKey: string;
  secondsKey: string;
  constraints?: TimeUnitConstraints;
};

export const configTimeUnitPairs = [
  {
    parentPath: ["agents", "codex"],
    millisecondsKey: "timeoutMs",
    secondsKey: "timeoutS",
  },
  {
    parentPath: ["agents", "claude"],
    millisecondsKey: "timeoutMs",
    secondsKey: "timeoutS",
  },
  {
    parentPath: ["agents", "codex", "openRouter"],
    millisecondsKey: "streamIdleTimeoutMs",
    secondsKey: "streamIdleTimeoutS",
    constraints: { minimumMilliseconds: 1_000 },
  },
  {
    parentPath: ["judge"],
    millisecondsKey: "timeoutMs",
    secondsKey: "timeoutS",
  },
  {
    parentPath: ["verification"],
    millisecondsKey: "timeoutMs",
    secondsKey: "timeoutS",
  },
  {
    parentPath: ["reviewBudget"],
    millisecondsKey: "maxTotalWallTimeMs",
    secondsKey: "maxTotalWallTimeS",
  },
] as const satisfies readonly ConfigTimeUnitPair[];

export function normalizeConfigTimeUnits(input: unknown): unknown {
  let normalized: unknown = input;
  for (const pair of configTimeUnitPairs) {
    normalized = updateRecordAtPath(normalized, pair.parentPath, (parent) =>
      normalizePair(parent, pair),
    );
  }
  return normalized;
}

function normalizePair(
  parent: Record<string, unknown>,
  pair: ConfigTimeUnitPair,
): Record<string, unknown> {
  const hasSecondsProperty = Object.hasOwn(parent, pair.secondsKey);
  if (!hasSecondsProperty) return parent;

  const normalized = { ...parent };
  if (parent[pair.secondsKey] === undefined) {
    delete normalized[pair.secondsKey];
    return normalized;
  }

  const parentPath = pair.parentPath.join(".");
  const resolved = resolveTimeUnitPair(
    {
      milliseconds: parent[pair.millisecondsKey],
      seconds: parent[pair.secondsKey],
    },
    {
      milliseconds: `${parentPath}.${pair.millisecondsKey}`,
      seconds: `${parentPath}.${pair.secondsKey}`,
    },
    pair.constraints,
  );
  if (resolved) normalized[pair.millisecondsKey] = resolved.milliseconds;
  delete normalized[pair.secondsKey];
  return normalized;
}

function updateRecordAtPath(
  input: unknown,
  path: readonly string[],
  update: (record: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  if (path.length === 0) {
    return isRecord(input) ? update(input) : input;
  }
  if (!isRecord(input)) return input;

  const [key, ...rest] = path;
  if (key === undefined) return input;
  const current = input[key];
  const updated = updateRecordAtPath(current, rest, update);
  return updated === current ? input : { ...input, [key]: updated };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
