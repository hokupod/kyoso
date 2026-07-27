const PROJECT_GLOBAL_ONLY_MESSAGE =
  "Move global-only settings to the user global config:";

const PROJECT_GLOBAL_ONLY_REASONS: Record<string, string> = {
  "agents.codex.allowProjectProvider":
    "must be a user-global exact project-directory allowlist",
  "tools.planReview": "must be a user-global tool availability policy",
  "tools.securityReview": "must be a user-global tool availability policy",
  "tools.diffReview": "must be a user-global tool availability policy",
};

type ProjectScopeOptions = {
  projectPath: string;
  globalConfigPath: string;
};

type Violation = {
  path: string;
  reason?: string;
};

export const kyosoConfigOverridePaths = [
  "agents.codex.enabled",
  "agents.codex.model",
  "agents.codex.provider",
  "agents.codex.openRouter.streamIdleTimeoutMs",
  "agents.codex.openRouter.streamIdleTimeoutS",
  "agents.codex.openRouter.streamMaxRetries",
  "agents.codex.openRouter.requestMaxRetries",
  "agents.codex.effort",
  "agents.codex.role",
  "agents.codex.timeoutMs",
  "agents.codex.timeoutS",
  "agents.claude.enabled",
  "agents.claude.model",
  "agents.claude.effort",
  "agents.claude.role",
  "agents.claude.timeoutMs",
  "agents.claude.timeoutS",
  "verification.enabled",
  "verification.maxFindings",
  "verification.timeoutMs",
  "verification.timeoutS",
  "judge.mode",
  "judge.provider",
  "judge.timeoutMs",
  "judge.timeoutS",
] as const;

const CONFIG_OVERRIDE_PATHS = new Set<string>(kyosoConfigOverridePaths);

export function isAllowedConfigOverridePath(path: string[]): boolean {
  return CONFIG_OVERRIDE_PATHS.has(path.join("."));
}

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
    const globalOnlyReason = projectGlobalOnlyReason(leaf.path);
    if (globalOnlyReason) {
      violations.push({ path, reason: globalOnlyReason });
      continue;
    }
    if (!isAllowedProjectPath(leaf.path)) {
      violations.push({ path });
      continue;
    }
    const reason = tightenOnlyReason(leaf.path, leaf.value);
    if (reason) violations.push({ path, reason });
  }
  return violations.sort((left, right) => left.path.localeCompare(right.path));
}

function projectGlobalOnlyReason(path: string[]): string | undefined {
  const exactReason = PROJECT_GLOBAL_ONLY_REASONS[path.join(".")];
  if (exactReason) return exactReason;
  if (path[0] === "reviewBudget") {
    return "must be a user-global review budget ceiling";
  }
  if (path[0] === "reviewPolicy") {
    return "must be a user-global review policy";
  }
  return undefined;
}

function isAllowedProjectPath(path: string[]): boolean {
  const [top, second, third, fourth] = path;
  if (isAllowedConfigOverridePath(path)) return true;
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
    `${PROJECT_GLOBAL_ONLY_MESSAGE} ${options.globalConfigPath}. If a key is misspelled, fix the name instead.`,
  ].join("\n");
}

export function flattenLeaves(
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
