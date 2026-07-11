import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { isPathWithin } from "../utils/pathContainment.js";
import { ensureTrustedDirectory } from "./stateRoot.js";

export const AUDIT_WARNING_UNSUPPORTED_OPEN_CAPABILITY =
  "AUDIT_DISABLED_UNSUPPORTED_CAPABILITY: Audit trace writing requires unavailable filesystem capabilities.";

export type AuditOpenConstants = Partial<
  Record<
    | "O_CREAT"
    | "O_EXCL"
    | "O_APPEND"
    | "O_WRONLY"
    | "O_NOFOLLOW"
    | "O_NONBLOCK",
    number
  >
>;

export type OpenVerifiedTraceFileOptions = {
  kyosoRoot: string;
  workspaceHash: string;
  logicalDirectory: string;
  date: string;
  traceId: string;
  uid: number;
  workspaceRoot: string;
  openConstants?: AuditOpenConstants;
  beforeOpen?: (tracePath: string) => Promise<void> | void;
};

export type OpenedTraceFile = {
  handle: FileHandle;
  tracePath: string;
};

export async function openVerifiedTraceFile(
  options: OpenVerifiedTraceFileOptions,
): Promise<OpenedTraceFile> {
  const flags = secureOpenFlags(options.openConstants);
  if (flags === undefined)
    throw new Error("secure open capability unavailable");
  if (!isSafeTraceId(options.traceId)) throw new Error("unsafe trace id");

  const traceDirectory = await ensureTrustedDirectory({
    root: options.kyosoRoot,
    segments: [
      "workspaces",
      options.workspaceHash,
      ...options.logicalDirectory.split("/"),
      options.date,
    ],
    uid: options.uid,
    workspaceRoot: options.workspaceRoot,
  });
  const tracePath = join(traceDirectory, `${options.traceId}.jsonl`);
  if (await optionalLstat(tracePath)) {
    throw new Error("trace path already exists");
  }

  await options.beforeOpen?.(tracePath);
  const handle = await open(tracePath, flags, 0o600);
  try {
    const [handleStat, pathStat, realTracePath] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(tracePath, { bigint: true }),
      realpath(tracePath),
    ]);
    if (
      !handleStat.isFile() ||
      !pathStat.isFile() ||
      handleStat.dev !== pathStat.dev ||
      handleStat.ino !== pathStat.ino ||
      !isPathWithin(realTracePath, options.kyosoRoot)
    ) {
      throw new Error("trace file identity could not be verified");
    }
    return { handle, tracePath };
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // The caller reports the primary fail-close outcome without filesystem detail.
    }
    throw error;
  }
}

export function secureOpenFlags(
  provided?: AuditOpenConstants,
): number | undefined {
  const openConstants = provided ?? constants;
  const required = [
    openConstants.O_CREAT,
    openConstants.O_EXCL,
    openConstants.O_APPEND,
    openConstants.O_WRONLY,
    openConstants.O_NOFOLLOW,
    openConstants.O_NONBLOCK,
  ];
  if (required.some((flag) => typeof flag !== "number" || flag <= 0)) {
    return undefined;
  }
  return required.reduce<number>(
    (combined, flag) => combined | (flag as number),
    0,
  );
}

function isSafeTraceId(traceId: string): boolean {
  return (
    traceId.length > 0 &&
    traceId !== "." &&
    traceId !== ".." &&
    !traceId.includes("/") &&
    !traceId.includes("\\")
  );
}

async function optionalLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}
