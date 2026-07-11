import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { KYOSO_VERSION } from "../core/constants.js";
import { isPathWithin } from "../utils/pathContainment.js";
import { CURRENT_SKILL_DIGEST, knownSkillDigest } from "./knownSkillDigests.js";

export const SKILL_INSTALL_MARKER = ".kyoso-install.json";
export const SKILL_INSTALL_BACKUP = ".kyoso-review.backup";
export const SKILL_INSTALL_TRANSACTION =
  ".kyoso-review.install-transaction.json";

export type ManagedSkillResult = {
  status: "dry-run" | "created" | "updated" | "skipped" | "conflict";
  path: string;
  detail: string;
};

type SkillInstallMarker = {
  schemaVersion: 1;
  installer: "@kyo-so/cli";
  cliVersion: string;
  digest: string;
};

type DirectoryFile = {
  relativePath: string;
  absolutePath: string;
};

export async function ensureManagedSkill(options: {
  sourceDir: string;
  destinationDir: string;
  trustedRoot: string;
  write: boolean;
  force: boolean;
}): Promise<ManagedSkillResult> {
  const sourceDigest = await hashSkillDirectory(options.sourceDir);
  if (sourceDigest !== CURRENT_SKILL_DIGEST) {
    throw new Error(
      `Bundled kyoso-review digest is ${sourceDigest}; update knownSkillDigests.ts before distributing it.`,
    );
  }

  const safeDestination = await resolveSafeDestination(
    options.trustedRoot,
    options.destinationDir,
  );
  const destinationDir = safeDestination.destinationDir;
  const recovery = await recoverInterruptedReplacement({
    destinationDir,
    trustedRoot: safeDestination.realRoot,
    write: options.write,
  });
  if (recovery.status !== "none") {
    return {
      status: recovery.status,
      path: destinationDir,
      detail: recovery.detail,
    };
  }
  const destinationStat = await optionalLstat(destinationDir);
  if (!destinationStat) {
    const detail = copyDetail(options.sourceDir, destinationDir, "create");
    if (!options.write) {
      return { status: "dry-run", path: destinationDir, detail };
    }
    await replaceSkillDirectory({
      sourceDir: options.sourceDir,
      destinationDir,
      trustedRoot: safeDestination.realRoot,
      destinationExists: false,
    });
    return { status: "created", path: destinationDir, detail };
  }

  if (!destinationStat.isDirectory()) {
    if (!options.force) {
      return conflictResult(
        destinationDir,
        "destination exists and is not a directory",
      );
    }
    const detail = copyDetail(
      options.sourceDir,
      destinationDir,
      "force replace",
    );
    if (!options.write) {
      return { status: "dry-run", path: destinationDir, detail };
    }
    await replaceSkillDirectory({
      sourceDir: options.sourceDir,
      destinationDir,
      trustedRoot: safeDestination.realRoot,
      destinationExists: true,
    });
    return { status: "updated", path: destinationDir, detail };
  }

  if (
    (await realpath(options.sourceDir)) === (await realpath(destinationDir))
  ) {
    return {
      status: "skipped",
      path: destinationDir,
      detail: "canonical source is already the destination",
    };
  }

  const actualDigest = await hashSkillDirectory(destinationDir);
  const marker = await readInstallMarker(destinationDir);

  if (options.force) {
    const detail = [
      `force replace ${destinationDir}`,
      `from ${actualDigest}`,
      `to   ${CURRENT_SKILL_DIGEST}`,
    ].join("\n");
    if (!options.write) {
      return { status: "dry-run", path: destinationDir, detail };
    }
    await replaceSkillDirectory({
      sourceDir: options.sourceDir,
      destinationDir,
      trustedRoot: safeDestination.realRoot,
      destinationExists: true,
    });
    return { status: "updated", path: destinationDir, detail };
  }

  if (marker.kind === "invalid") {
    return conflictResult(destinationDir, marker.reason);
  }

  if (marker.kind === "valid") {
    if (marker.value.digest !== actualDigest) {
      return conflictResult(
        destinationDir,
        `managed digest ${marker.value.digest} does not match installed digest ${actualDigest}`,
      );
    }
    if (
      actualDigest === CURRENT_SKILL_DIGEST &&
      marker.value.cliVersion === KYOSO_VERSION
    ) {
      return {
        status: "skipped",
        path: destinationDir,
        detail: `managed skill is current (${CURRENT_SKILL_DIGEST})`,
      };
    }
    if (actualDigest === CURRENT_SKILL_DIGEST) {
      const detail = `refresh install marker to CLI ${KYOSO_VERSION}`;
      if (!options.write) {
        return { status: "dry-run", path: destinationDir, detail };
      }
      await writeInstallMarker(destinationDir);
      return { status: "updated", path: destinationDir, detail };
    }

    const detail = [
      `update managed skill from ${actualDigest}`,
      `to ${CURRENT_SKILL_DIGEST}`,
    ].join("\n");
    if (!options.write) {
      return { status: "dry-run", path: destinationDir, detail };
    }
    await replaceSkillDirectory({
      sourceDir: options.sourceDir,
      destinationDir,
      trustedRoot: safeDestination.realRoot,
      destinationExists: true,
    });
    return { status: "updated", path: destinationDir, detail };
  }

  const known = knownSkillDigest(actualDigest);
  if (!known) {
    return conflictResult(
      destinationDir,
      `unmanaged skill digest ${actualDigest} is not recognized`,
    );
  }

  if (actualDigest === CURRENT_SKILL_DIGEST) {
    const detail = `adopt existing ${known.version} skill and write ${SKILL_INSTALL_MARKER}`;
    if (!options.write) {
      return { status: "dry-run", path: destinationDir, detail };
    }
    await writeInstallMarker(destinationDir);
    return { status: "updated", path: destinationDir, detail };
  }

  const detail = [
    `adopt known ${known.version} ${known.kind} skill (${actualDigest})`,
    `update to ${CURRENT_SKILL_DIGEST}`,
  ].join("\n");
  if (!options.write) {
    return { status: "dry-run", path: destinationDir, detail };
  }
  await replaceSkillDirectory({
    sourceDir: options.sourceDir,
    destinationDir,
    trustedRoot: safeDestination.realRoot,
    destinationExists: true,
  });
  return { status: "updated", path: destinationDir, detail };
}

export async function hashSkillDirectory(directory: string): Promise<string> {
  const rootStat = await lstat(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Skill root must be a regular directory: ${directory}`);
  }

  const files = await listRegularFiles(directory);
  files.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath),
      Buffer.from(right.relativePath),
    ),
  );

  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function listRegularFiles(
  directory: string,
  prefix = "",
): Promise<DirectoryFile[]> {
  const result: DirectoryFile[] = [];
  const entries = await readdir(directory);
  for (const name of entries) {
    const relativePath = prefix.length > 0 ? `${prefix}/${name}` : name;
    const absolutePath = join(directory, name);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill directory contains a symlink: ${relativePath}`);
    }
    if (relativePath === SKILL_INSTALL_MARKER) {
      if (!stat.isFile()) {
        throw new Error(`${SKILL_INSTALL_MARKER} must be a regular file`);
      }
      continue;
    }
    if (stat.isDirectory()) {
      result.push(...(await listRegularFiles(absolutePath, relativePath)));
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Skill directory contains a non-regular file: ${relativePath}`,
      );
    }
    result.push({ relativePath, absolutePath });
  }
  return result;
}

async function resolveSafeDestination(
  trustedRoot: string,
  destinationDir: string,
): Promise<{ realRoot: string; destinationDir: string }> {
  const logicalRoot = resolve(trustedRoot);
  const logicalDestination = resolve(destinationDir);
  const relativeDestination = relative(logicalRoot, logicalDestination);
  if (
    relativeDestination === "" ||
    !isPathWithin(logicalDestination, logicalRoot)
  ) {
    throw new Error(
      `Skill destination escapes trusted install root: ${destinationDir}`,
    );
  }

  const realRoot = await realpath(logicalRoot);
  const safeDestination = resolve(realRoot, relativeDestination);
  if (!isPathWithin(safeDestination, realRoot)) {
    throw new Error(
      `Skill destination escapes trusted install root: ${destinationDir}`,
    );
  }
  await assertExistingSegmentsSafe(realRoot, safeDestination);
  return { realRoot, destinationDir: safeDestination };
}

async function assertExistingSegmentsSafe(
  realRoot: string,
  destination: string,
): Promise<void> {
  const segments = relative(realRoot, destination).split(sep).filter(Boolean);
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = await optionalLstat(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill install path contains a symlink: ${current}`);
    }
    if (current !== destination && !stat.isDirectory()) {
      throw new Error(`Skill install parent is not a directory: ${current}`);
    }
  }
}

async function ensureSafeParent(
  realRoot: string,
  destinationDir: string,
): Promise<void> {
  const parent = dirname(destinationDir);
  const relativeParent = relative(realRoot, parent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  ) {
    throw new Error(`Skill install parent escapes trusted root: ${parent}`);
  }
  const segments = relative(realRoot, parent).split(sep).filter(Boolean);
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    let stat = await optionalLstat(current);
    if (!stat) {
      await mkdir(current);
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Skill install parent is unsafe: ${current}`);
    }
  }
}

async function replaceSkillDirectory(options: {
  sourceDir: string;
  destinationDir: string;
  trustedRoot: string;
  destinationExists: boolean;
}): Promise<void> {
  await ensureSafeParent(options.trustedRoot, options.destinationDir);
  await assertExistingSegmentsSafe(options.trustedRoot, options.destinationDir);

  const parent = dirname(options.destinationDir);
  const mutationGuard = await captureMutationGuard(parent);
  const stage = await mkdtemp(join(parent, ".kyoso-review.stage-"));
  const backup = join(parent, SKILL_INSTALL_BACKUP);
  const transaction = join(parent, SKILL_INSTALL_TRANSACTION);
  let backupCreated = false;
  let transactionCreated = false;
  try {
    await copySkillFiles(options.sourceDir, stage);
    await writeInstallMarker(stage);
    const stagedDigest = await hashSkillDirectory(stage);
    if (stagedDigest !== CURRENT_SKILL_DIGEST) {
      throw new Error(
        `Staged kyoso-review digest mismatch: ${stagedDigest} != ${CURRENT_SKILL_DIGEST}`,
      );
    }

    if (options.destinationExists) {
      await assertMutationGuard(mutationGuard);
      if ((await optionalLstat(backup)) || (await optionalLstat(transaction))) {
        throw interruptedReplacementConflict(options.destinationDir, backup);
      }
      await writeReplacementTransaction(transaction, options.destinationDir);
      transactionCreated = true;
      await assertMutationGuard(mutationGuard);
      await rename(options.destinationDir, backup);
      backupCreated = true;
      await assertMutationGuard(mutationGuard);
    }
    try {
      await assertMutationGuard(mutationGuard);
      await rename(stage, options.destinationDir);
      await assertMutationGuard(mutationGuard);
    } catch (error) {
      if (backupCreated && !(await optionalLstat(options.destinationDir))) {
        await assertMutationGuard(mutationGuard);
        await rename(backup, options.destinationDir);
        backupCreated = false;
        await assertMutationGuard(mutationGuard);
        await rm(transaction, { force: true });
        transactionCreated = false;
        await assertMutationGuard(mutationGuard);
      }
      throw error;
    }

    if (backupCreated) {
      await assertMutationGuard(mutationGuard);
      await rm(backup, { recursive: true, force: true });
      backupCreated = false;
      await assertMutationGuard(mutationGuard);
      await rm(transaction, { force: true });
      transactionCreated = false;
      await assertMutationGuard(mutationGuard);
    }
  } finally {
    await assertMutationGuard(mutationGuard);
    await rm(stage, { recursive: true, force: true });
    if (backupCreated && !(await optionalLstat(options.destinationDir))) {
      await assertMutationGuard(mutationGuard);
      await rename(backup, options.destinationDir);
      backupCreated = false;
      await assertMutationGuard(mutationGuard);
    }
    if (transactionCreated && !backupCreated) {
      await rm(transaction, { force: true });
    }
  }
}

type MutationGuard = {
  parent: string;
  realParent: string;
  device: number;
  inode: number;
};

async function captureMutationGuard(parent: string): Promise<MutationGuard> {
  const stat = await lstat(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Skill install parent is unsafe: ${parent}`);
  }
  const realParent = await realpath(parent);
  if (realParent !== parent) {
    throw new Error(`Skill install parent changed during setup: ${parent}`);
  }
  return {
    parent,
    realParent,
    device: stat.dev,
    inode: stat.ino,
  };
}

async function assertMutationGuard(guard: MutationGuard): Promise<void> {
  const stat = await optionalLstat(guard.parent);
  if (
    !stat ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== guard.device ||
    stat.ino !== guard.inode ||
    (await realpath(guard.parent)) !== guard.realParent
  ) {
    throw new Error(
      `Skill install parent changed during setup: ${guard.parent}. No further path mutation was attempted.`,
    );
  }
}

async function recoverInterruptedReplacement(options: {
  destinationDir: string;
  trustedRoot: string;
  write: boolean;
}): Promise<
  { status: "none" } | { status: "dry-run" | "updated"; detail: string }
> {
  const parent = dirname(options.destinationDir);
  const backup = join(parent, SKILL_INSTALL_BACKUP);
  const transaction = join(parent, SKILL_INSTALL_TRANSACTION);
  const backupStat = await optionalLstat(backup);
  const transactionStat = await optionalLstat(transaction);
  if (!backupStat && !transactionStat) return { status: "none" };
  if (backupStat?.isSymbolicLink()) {
    throw new Error(`Interrupted Skill backup is a symlink: ${backup}`);
  }
  if (transactionStat?.isSymbolicLink() || !transactionStat?.isFile()) {
    throw new Error(
      `Interrupted Skill transaction marker is not a regular file: ${transaction}`,
    );
  }
  if (!backupStat) {
    await assertExistingSegmentsSafe(options.trustedRoot, transaction);
  } else {
    await assertExistingSegmentsSafe(options.trustedRoot, backup);
  }
  const parsed = await readReplacementTransaction(transaction);
  if (
    parsed.destinationName !== basename(options.destinationDir) ||
    parsed.backupName !== SKILL_INSTALL_BACKUP
  ) {
    throw new Error(
      `Interrupted Skill transaction does not match ${options.destinationDir}: ${transaction}`,
    );
  }

  const destinationStat = await optionalLstat(options.destinationDir);
  if (backupStat && destinationStat) {
    throw interruptedReplacementConflict(options.destinationDir, backup);
  }
  if (!backupStat && !destinationStat) {
    throw new Error(
      `Interrupted Skill transaction has neither destination nor backup: ${transaction}`,
    );
  }
  if (!options.write) {
    return {
      status: "dry-run",
      detail: backupStat
        ? `recover interrupted skill replacement from ${SKILL_INSTALL_BACKUP}`
        : `clean completed Skill replacement marker ${SKILL_INSTALL_TRANSACTION}`,
    };
  }

  const mutationGuard = await captureMutationGuard(parent);
  await assertMutationGuard(mutationGuard);
  if (backupStat) {
    await rename(backup, options.destinationDir);
  }
  await assertMutationGuard(mutationGuard);
  await rm(transaction, { force: true });
  await assertMutationGuard(mutationGuard);
  return {
    status: "updated",
    detail: backupStat
      ? `recovered interrupted skill replacement from ${SKILL_INSTALL_BACKUP}; rerun setup to apply the requested install`
      : `cleaned completed Skill replacement marker ${SKILL_INSTALL_TRANSACTION}; rerun setup to verify the installed Skill`,
  };
}

function interruptedReplacementConflict(
  destinationDir: string,
  backup: string,
): Error {
  return new Error(
    `Interrupted Skill replacement is ambiguous because both ${destinationDir} and ${backup} exist. Inspect both directories and remove ${backup} only after preserving any needed files.`,
  );
}

type SkillReplacementTransaction = {
  schemaVersion: 1;
  installer: "@kyo-so/cli";
  destinationName: string;
  backupName: typeof SKILL_INSTALL_BACKUP;
};

async function writeReplacementTransaction(
  transactionPath: string,
  destinationDir: string,
): Promise<void> {
  const transaction: SkillReplacementTransaction = {
    schemaVersion: 1,
    installer: "@kyo-so/cli",
    destinationName: basename(destinationDir),
    backupName: SKILL_INSTALL_BACKUP,
  };
  const temporaryPath = `${transactionPath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(transaction, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await link(temporaryPath, transactionPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readReplacementTransaction(
  transactionPath: string,
): Promise<SkillReplacementTransaction> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(transactionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Interrupted Skill transaction is invalid: ${transactionPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isReplacementTransaction(parsed)) {
    throw new Error(
      `Interrupted Skill transaction has an invalid schema: ${transactionPath}`,
    );
  }
  return parsed;
}

function isReplacementTransaction(
  value: unknown,
): value is SkillReplacementTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.installer === "@kyo-so/cli" &&
    typeof candidate.destinationName === "string" &&
    candidate.destinationName.length > 0 &&
    candidate.backupName === SKILL_INSTALL_BACKUP
  );
}

async function copySkillFiles(sourceDir: string, destinationDir: string) {
  for (const file of await listRegularFiles(sourceDir)) {
    const destination = join(destinationDir, ...file.relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file.absolutePath, destination);
  }
}

async function readInstallMarker(
  destinationDir: string,
): Promise<
  | { kind: "missing" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; value: SkillInstallMarker }
> {
  const markerPath = join(destinationDir, SKILL_INSTALL_MARKER);
  const markerStat = await optionalLstat(markerPath);
  if (!markerStat) return { kind: "missing" };
  if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
    return {
      kind: "invalid",
      reason: `${SKILL_INSTALL_MARKER} is not a regular file`,
    };
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (!isInstallMarker(parsed)) {
      return {
        kind: "invalid",
        reason: `${SKILL_INSTALL_MARKER} has an invalid schema`,
      };
    }
    return { kind: "valid", value: parsed };
  } catch (error) {
    return {
      kind: "invalid",
      reason: `${SKILL_INSTALL_MARKER} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function writeInstallMarker(destinationDir: string): Promise<void> {
  const marker: SkillInstallMarker = {
    schemaVersion: 1,
    installer: "@kyo-so/cli",
    cliVersion: KYOSO_VERSION,
    digest: CURRENT_SKILL_DIGEST,
  };
  const markerPath = join(destinationDir, SKILL_INSTALL_MARKER);
  const temporaryPath = join(
    destinationDir,
    `${SKILL_INSTALL_MARKER}.tmp-${randomUUID()}`,
  );
  await writeFile(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporaryPath, markerPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isInstallMarker(value: unknown): value is SkillInstallMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.installer === "@kyo-so/cli" &&
    typeof candidate.cliVersion === "string" &&
    candidate.cliVersion.length > 0 &&
    typeof candidate.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(candidate.digest)
  );
}

function copyDetail(
  sourceDir: string,
  destinationDir: string,
  action: string,
): string {
  return [
    `${action} ${sourceDir}`,
    `to ${destinationDir}`,
    `digest ${CURRENT_SKILL_DIGEST}`,
  ].join("\n");
}

function conflictResult(
  destinationDir: string,
  reason: string,
): ManagedSkillResult {
  return {
    status: "conflict",
    path: destinationDir,
    detail: `${reason}\nExisting skill was not changed. Rerun with --force to replace only this skill directory.`,
  };
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
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
