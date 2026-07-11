import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeRelativePath } from "../context/pathPolicy.js";
import { TRACE_DIR } from "../core/constants.js";
import { isPathWithin } from "../utils/pathContainment.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const UNSAFE_DIRECTORY_MODE = 0o022;
const STICKY_DIRECTORY_MODE = 0o1000;

export const AUDIT_WARNING_DIRECTORY_IGNORED =
  "AUDIT_DIRECTORY_IGNORED: Audit directory is invalid; using the default logical directory.";
export const AUDIT_WARNING_UNSUPPORTED_PLATFORM =
  "AUDIT_DISABLED_UNSUPPORTED_PLATFORM: Audit trace writing is unavailable on this platform.";
export const AUDIT_WARNING_UNSUPPORTED_CAPABILITY =
  "AUDIT_DISABLED_UNSUPPORTED_CAPABILITY: Audit trace writing requires unavailable filesystem capabilities.";
export const AUDIT_WARNING_UNSAFE_STATE_ROOT =
  "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.";

export type AuditRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  getuid?: () => number | undefined;
};

export type ResolvedAuditStateRoot = {
  stateBase: string;
  kyosoRoot: string;
  workspaceRoot: string;
  workspaceHash: string;
  logicalDirectory: string;
  uid: number;
  warnings: string[];
};

export type AuditStateRootResolution =
  ResolvedAuditStateRoot | { warnings: string[] };

export type AuditStateRootCapability = {
  available: boolean;
};

export async function resolveAuditStateRoot(
  options: {
    cwd: string;
    directory: string;
  } & AuditRuntimeOptions,
): Promise<AuditStateRootResolution> {
  const warnings: string[] = [];
  const logicalDirectory = validateAuditDirectory(options.directory, warnings);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return { warnings: [...warnings, AUDIT_WARNING_UNSUPPORTED_PLATFORM] };
  }

  const uid = getCurrentUid(options.getuid);
  if (uid === undefined) {
    return { warnings: [...warnings, AUDIT_WARNING_UNSUPPORTED_CAPABILITY] };
  }

  try {
    const workspaceRoot = await realpath(resolve(options.cwd));
    const candidate = resolveStateBaseCandidate(options.env ?? process.env);
    if (!candidate) throw new Error("missing trusted state base");
    const stateBase = await ensureTrustedStateBase({
      candidate,
      workspaceRoot,
      uid,
    });
    const kyosoRoot = await ensureTrustedDirectory({
      root: stateBase,
      segments: ["kyoso"],
      uid,
      workspaceRoot,
    });
    return {
      stateBase,
      kyosoRoot,
      workspaceRoot,
      workspaceHash: createHash("sha256").update(workspaceRoot).digest("hex"),
      logicalDirectory,
      uid,
      warnings,
    };
  } catch {
    return { warnings: [...warnings, AUDIT_WARNING_UNSAFE_STATE_ROOT] };
  }
}

export async function inspectAuditStateRootCapability(
  options: {
    cwd: string;
  } & AuditRuntimeOptions,
): Promise<AuditStateRootCapability> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || getCurrentUid(options.getuid) === undefined) {
    return { available: false };
  }

  try {
    const uid = getCurrentUid(options.getuid);
    if (uid === undefined) return { available: false };
    const workspaceRoot = await realpath(resolve(options.cwd));
    const candidate = resolveStateBaseCandidate(options.env ?? process.env);
    if (!candidate || isPathWithin(candidate, workspaceRoot)) {
      return { available: false };
    }

    const existing = await findExistingAncestor(candidate);
    assertSafeDirectory(existing.path, uid, await lstat(existing.path), {
      allowFilesystemRoot: true,
    });
    const realExisting = await realpath(existing.path);
    if (isPathWithin(realExisting, workspaceRoot)) return { available: false };
    await assertTrustedAncestorChain(realExisting, uid);

    if (existing.missingSegments.length === 0) {
      const kyosoRoot = join(realExisting, "kyoso");
      const kyosoStat = await optionalLstat(kyosoRoot);
      if (kyosoStat) assertSafeDirectory(kyosoRoot, uid, kyosoStat);
    }
    return { available: true };
  } catch {
    return { available: false };
  }
}

export async function ensureTrustedDirectory(options: {
  root: string;
  segments: string[];
  uid: number;
  workspaceRoot?: string;
}): Promise<string> {
  const realRoot = await realpath(options.root);
  assertSafeDirectory(realRoot, options.uid, await lstat(realRoot));
  if (options.workspaceRoot && isPathWithin(realRoot, options.workspaceRoot)) {
    throw new Error("trusted directory resolves inside workspace");
  }
  await assertTrustedAncestorChain(realRoot, options.uid);
  let current = realRoot;
  for (const segment of options.segments) {
    if (!isSafePathSegment(segment)) throw new Error("unsafe path segment");
    const next = join(current, segment);
    let entry = await optionalLstat(next);
    if (!entry) {
      await createDirectory(next);
      entry = await lstat(next);
    }
    assertSafeDirectory(next, options.uid, entry);
    const realNext = await realpath(next);
    if (!isPathWithin(realNext, realRoot)) {
      throw new Error("managed directory escaped trusted root");
    }
    if (
      options.workspaceRoot &&
      isPathWithin(realNext, options.workspaceRoot)
    ) {
      throw new Error("managed directory resolves inside workspace");
    }
    current = realNext;
  }
  return current;
}

export function isResolvedAuditStateRoot(
  resolution: AuditStateRootResolution,
): resolution is ResolvedAuditStateRoot {
  return "kyosoRoot" in resolution;
}

function validateAuditDirectory(directory: string, warnings: string[]): string {
  try {
    if (
      directory.trim().length === 0 ||
      isAbsolute(directory) ||
      directory.split(/[\\/]+/).includes("..")
    ) {
      throw new Error("unsafe logical directory");
    }
    const normalized = normalizeRelativePath(directory);
    if (normalized === "." || normalized.split("/").includes("..")) {
      throw new Error("unsafe logical directory");
    }
    return normalized;
  } catch {
    warnings.push(AUDIT_WARNING_DIRECTORY_IGNORED);
    return TRACE_DIR;
  }
}

function resolveStateBaseCandidate(env: NodeJS.ProcessEnv): string | undefined {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && isAbsolute(xdgStateHome)) {
    return resolve(xdgStateHome);
  }

  const home = env.HOME?.trim();
  if (!home || !isAbsolute(home)) return undefined;
  return join(resolve(home), ".local", "state");
}

async function ensureTrustedStateBase(options: {
  candidate: string;
  workspaceRoot: string;
  uid: number;
}): Promise<string> {
  if (isPathWithin(options.candidate, options.workspaceRoot)) {
    throw new Error("state base is inside workspace");
  }

  const existing = await findExistingAncestor(options.candidate);
  assertSafeDirectory(existing.path, options.uid, await lstat(existing.path), {
    allowFilesystemRoot: true,
  });
  const realExisting = await realpath(existing.path);
  if (isPathWithin(realExisting, options.workspaceRoot)) {
    throw new Error("state base resolves inside workspace");
  }
  await assertTrustedAncestorChain(realExisting, options.uid);

  let current = realExisting;
  for (const segment of existing.missingSegments) {
    current = join(current, segment);
    await createDirectory(current);
    const entry = await lstat(current);
    assertSafeDirectory(current, options.uid, entry);
    const realCurrent = await realpath(current);
    if (!isPathWithin(realCurrent, realExisting)) {
      throw new Error("state base changed while being created");
    }
    if (isPathWithin(realCurrent, options.workspaceRoot)) {
      throw new Error("state base resolves inside workspace");
    }
    current = realCurrent;
  }

  const stateBase = await realpath(current);
  assertSafeDirectory(stateBase, options.uid, await lstat(stateBase));
  if (isPathWithin(stateBase, options.workspaceRoot)) {
    throw new Error("state base resolves inside workspace");
  }
  await assertTrustedAncestorChain(stateBase, options.uid);
  return stateBase;
}

async function findExistingAncestor(candidate: string): Promise<{
  path: string;
  missingSegments: string[];
}> {
  let current = resolve(candidate);
  const missingSegments: string[] = [];
  while (true) {
    const entry = await optionalLstat(current);
    if (entry) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("state base ancestor is unsafe");
      }
      return { path: current, missingSegments };
    }
    const parent = dirname(current);
    if (parent === current)
      throw new Error("state base has no existing ancestor");
    missingSegments.unshift(basename(current));
    current = parent;
  }
}

function assertSafeDirectory(
  path: string,
  uid: number,
  entry?: Awaited<ReturnType<typeof lstat>>,
  options: { allowFilesystemRoot?: boolean } = {},
): void {
  const stat = entry;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("state directory is unsafe");
  }
  if (
    numericStatValue(stat.uid) !== uid &&
    !(options.allowFilesystemRoot && isFilesystemRoot(path))
  ) {
    throw new Error("state directory owner is unsafe");
  }
  const mode = numericStatValue(stat.mode);
  if ((mode & UNSAFE_DIRECTORY_MODE) !== 0) {
    throw new Error("state directory mode is unsafe");
  }
}

function numericStatValue(value: number | bigint): number {
  return typeof value === "number" ? value : Number(value);
}

function getCurrentUid(
  getuid: AuditRuntimeOptions["getuid"],
): number | undefined {
  const resolveUid =
    getuid ??
    (typeof process.getuid === "function"
      ? process.getuid.bind(process)
      : undefined);
  try {
    const uid = resolveUid?.();
    return typeof uid === "number" && Number.isInteger(uid) && uid >= 0
      ? uid
      : undefined;
  } catch {
    return undefined;
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path;
}

async function assertTrustedAncestorChain(
  path: string,
  uid: number,
): Promise<void> {
  let child = path;
  while (!isFilesystemRoot(child)) {
    const parent = dirname(child);
    const [parentStat, childStat] = await Promise.all([
      lstat(parent),
      lstat(child),
    ]);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error("state directory ancestor is unsafe");
    }
    const parentMode = numericStatValue(parentStat.mode);
    const parentUid = numericStatValue(parentStat.uid);
    const childUid = numericStatValue(childStat.uid);
    const parentWritableByOthers = (parentMode & UNSAFE_DIRECTORY_MODE) !== 0;
    const stickyChildEntry =
      (parentMode & STICKY_DIRECTORY_MODE) !== 0 && childUid === uid;
    if (
      (parentUid !== uid && parentUid !== 0) ||
      (parentWritableByOthers && !stickyChildEntry)
    ) {
      throw new Error("state directory ancestor permissions are unsafe");
    }
    child = parent;
  }
}

function isSafePathSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("/") &&
    !segment.includes("\\")
  );
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function createDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}
