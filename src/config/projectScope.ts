const PROJECT_GLOBAL_ONLY_MESSAGE =
  "Move these settings to the user global config instead.";

type ProjectScopeOptions = {
  projectPath: string;
  globalConfigPath: string;
};

type Violation = {
  path: string;
  reason?: string;
};

export function mergeProjectTomlConfig(
  baseConfig: unknown,
  projectConfig: unknown,
  options: ProjectScopeOptions,
): unknown {
  const violations = collectProjectScopeViolations(projectConfig);
  if (violations.length > 0) {
    throw new Error(formatProjectScopeError(violations, options));
  }

  const projectDeny = readPath(projectConfig, ["workspace", "deny"]);
  const mergeableProjectConfig = omitPath(projectConfig, ["workspace", "deny"]);
  const merged = deepMerge(baseConfig, mergeableProjectConfig);
  if (projectDeny !== undefined) {
    writePath(
      merged,
      ["workspace", "deny"],
      Array.isArray(projectDeny) && allStrings(projectDeny)
        ? unionStrings(readStringArray(baseConfig, ["workspace", "deny"]), [
            ...projectDeny,
          ])
        : projectDeny,
    );
  }
  return merged;
}

export function collectProjectScopeViolations(config: unknown): Violation[] {
  const leaves = flattenLeaves(config);
  const violations: Violation[] = [];
  for (const leaf of leaves) {
    const path = leaf.path.join(".");
    if (!isAllowedProjectPath(leaf.path)) {
      violations.push({ path });
      continue;
    }
    const reason = tightenOnlyReason(leaf.path, leaf.value);
    if (reason) violations.push({ path, reason });
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

function isAllowedProjectPath(path: string[]): boolean {
  const [top, second, third, fourth] = path;
  if (
    top === "tools" &&
    path.length === 2 &&
    ["planReview", "securityReview", "diffReview"].includes(second ?? "")
  ) {
    return true;
  }
  if (
    top === "agents" &&
    path.length === 3 &&
    ["codex", "claude"].includes(second ?? "") &&
    ["enabled", "model", "role", "timeoutMs"].includes(third ?? "")
  ) {
    return true;
  }
  if (
    top === "verification" &&
    path.length === 2 &&
    ["enabled", "maxFindings", "timeoutMs"].includes(second ?? "")
  ) {
    return true;
  }
  if (
    top === "workspace" &&
    path.length === 2 &&
    ["maxContextBytes", "maxDiffBytes", "deny"].includes(second ?? "")
  ) {
    return true;
  }
  if (top === "network" && second === "defaultMode" && path.length === 2) {
    return true;
  }
  if (
    top === "secrets" &&
    path.length === 2 &&
    ["blockOnDetectedSecret", "allowOverride"].includes(second ?? "")
  ) {
    return true;
  }
  if (
    top === "judge" &&
    path.length === 2 &&
    ["mode", "provider", "timeoutMs"].includes(second ?? "")
  ) {
    return true;
  }
  if (
    top === "securityReview" &&
    second === "cisaSecureByDesign" &&
    path.length >= 3
  ) {
    if (third === "dimensions") {
      return (
        path.length === 4 &&
        [
          "customerSecurityOutcomes",
          "secureByDefault",
          "transparencyAndAccountability",
          "governance",
        ].includes(fourth ?? "")
      );
    }
    return path.length === 3 && ["enabled", "gate"].includes(third ?? "");
  }
  return false;
}

function tightenOnlyReason(path: string[], value: unknown): string | undefined {
  const dotted = path.join(".");
  if (dotted === "network.defaultMode" && value !== "model_only") {
    return 'must be "model_only" in project TOML';
  }
  if (dotted === "secrets.blockOnDetectedSecret" && value !== true) {
    return "must be true in project TOML";
  }
  if (dotted === "secrets.allowOverride" && value !== false) {
    return "must be false in project TOML";
  }
  if (
    path[0] === "securityReview" &&
    path[1] === "cisaSecureByDesign" &&
    value !== true
  ) {
    return "must be true in project TOML";
  }
  return undefined;
}

function formatProjectScopeError(
  violations: Violation[],
  options: ProjectScopeOptions,
): string {
  const entries = violations.map((violation) =>
    violation.reason
      ? `${violation.path} (${violation.reason})`
      : violation.path,
  );
  return [
    `Project TOML config ${options.projectPath} contains settings that are not allowed in project scope: ${entries.join(", ")}`,
    `${PROJECT_GLOBAL_ONLY_MESSAGE} ${options.globalConfigPath}`,
  ].join("\n");
}

function flattenLeaves(
  value: unknown,
  path: string[] = [],
): Array<{ path: string[]; value: unknown }> {
  if (!isRecord(value)) return path.length > 0 ? [{ path, value }] : [];
  const entries = Object.entries(value);
  if (entries.length === 0) return path.length > 0 ? [{ path, value }] : [];
  return entries.flatMap(([key, child]) =>
    flattenLeaves(child, [...path, key]),
  );
}

function omitPath(value: unknown, path: string[]): unknown {
  if (!isRecord(value) || path.length === 0) return value;
  const [head, ...tail] = path;
  if (head === undefined) return value;
  const result: Record<string, unknown> = { ...value };
  if (tail.length === 0) {
    delete result[head];
  } else {
    const child = omitPath(result[head], tail);
    if (isRecord(child) && Object.keys(child).length === 0) {
      delete result[head];
    } else {
      result[head] = child;
    }
  }
  return result;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function writePath(target: unknown, path: string[], value: unknown): void {
  if (!isRecord(target)) return;
  let current: Record<string, unknown> = target;
  for (const key of path.slice(0, -1)) {
    const child = current[key];
    if (!isRecord(child)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const leaf = path.at(-1);
  if (leaf) current[leaf] = value;
}

function readStringArray(value: unknown, path: string[]): string[] {
  const found = readPath(value, path);
  return Array.isArray(found) && allStrings(found) ? [...found] : [];
}

function unionStrings(base: string[], override: string[]): string[] {
  return [...new Set([...base, ...override])];
}

function allStrings(values: unknown[]): values is string[] {
  return values.every((value) => typeof value === "string");
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isRecord(base) || !isRecord(override)) return override ?? base;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = deepMerge(result[key], value);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
