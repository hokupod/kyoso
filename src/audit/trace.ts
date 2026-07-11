import type { FileHandle } from "node:fs/promises";
import {
  type AuditRuntimeOptions,
  isResolvedAuditStateRoot,
  resolveAuditStateRoot,
} from "./stateRoot.js";
import {
  AUDIT_WARNING_UNSUPPORTED_OPEN_CAPABILITY,
  type AuditOpenConstants,
  openVerifiedTraceFile,
  secureOpenFlags,
} from "./safeTraceFile.js";
import { sanitizeForAudit } from "./sanitize.js";

export const AUDIT_WARNING_WRITE_FAILED =
  "AUDIT_WRITE_FAILED: Audit trace writing failed; no further audit events will be written.";
export const AUDIT_WARNING_FINALIZE_FAILED =
  "AUDIT_FINALIZE_FAILED: Audit trace close failed.";
export const AUDIT_WARNING_WRITE_AFTER_FINALIZE =
  "AUDIT_WRITE_AFTER_FINALIZE: Audit trace is already finalized.";

export type TraceWriter = {
  readonly tracePath?: string;
  warnings: string[];
  write(event: Record<string, unknown>): Promise<void>;
  finalize(): Promise<void>;
};

export type TraceWriterOptions = {
  enabled: boolean;
  directory: string;
  traceId: string;
  cwd: string;
  includeRawAgentOutput?: boolean;
  openConstants?: AuditOpenConstants;
  beforeOpen?: (tracePath: string) => Promise<void> | void;
  closeHandle?: (handle: FileHandle) => Promise<void>;
  writeChunk?: (
    handle: FileHandle,
    buffer: Buffer,
    offset: number,
  ) => Promise<number>;
} & AuditRuntimeOptions;

export function createTraceWriter(options: TraceWriterOptions): TraceWriter {
  const warnings: string[] = [];
  const warningSet = new Set<string>();
  const date = new Date().toISOString().slice(0, 10);
  let tracePath: string | undefined;
  let handle: FileHandle | undefined;
  let disabled = !options.enabled;
  let finalizing = false;
  let finalized = false;
  let queue = Promise.resolve();
  let finalizePromise: Promise<void> | undefined;

  const addWarning = (warning: string): void => {
    if (warningSet.has(warning)) return;
    warningSet.add(warning);
    warnings.push(warning);
  };

  const closeHandle = async (): Promise<void> => {
    const current = handle;
    handle = undefined;
    if (!current) return;
    try {
      await (options.closeHandle ?? defaultCloseHandle)(current);
    } catch {
      addWarning(AUDIT_WARNING_FINALIZE_FAILED);
    }
  };

  const disableAfterWriteFailure = async (): Promise<void> => {
    disabled = true;
    addWarning(AUDIT_WARNING_WRITE_FAILED);
    await closeHandle();
  };

  const openIfNeeded = async (): Promise<void> => {
    if (handle || disabled) return;
    if (secureOpenFlags(options.openConstants) === undefined) {
      disabled = true;
      addWarning(AUDIT_WARNING_UNSUPPORTED_OPEN_CAPABILITY);
      return;
    }

    const stateRoot = await resolveAuditStateRoot({
      cwd: options.cwd,
      directory: options.directory,
      env: options.env,
      platform: options.platform,
      getuid: options.getuid,
    });
    for (const warning of stateRoot.warnings) addWarning(warning);
    if (!isResolvedAuditStateRoot(stateRoot)) {
      disabled = true;
      return;
    }

    try {
      const opened = await openVerifiedTraceFile({
        kyosoRoot: stateRoot.kyosoRoot,
        workspaceHash: stateRoot.workspaceHash,
        logicalDirectory: stateRoot.logicalDirectory,
        date,
        traceId: options.traceId,
        uid: stateRoot.uid,
        workspaceRoot: stateRoot.workspaceRoot,
        openConstants: options.openConstants,
        beforeOpen: options.beforeOpen,
      });
      handle = opened.handle;
      tracePath = opened.tracePath;
    } catch {
      disabled = true;
      addWarning(AUDIT_WARNING_WRITE_FAILED);
    }
  };

  const writeOne = async (event: Record<string, unknown>): Promise<void> => {
    if (disabled) return;
    try {
      await openIfNeeded();
      if (disabled || !handle) return;
      const line = Buffer.from(
        `${JSON.stringify(
          sanitizeForAudit(event, {
            includeRawAgentOutput: options.includeRawAgentOutput,
          }),
        )}\n`,
        "utf8",
      );
      await writeFully(handle, line, options.writeChunk);
    } catch {
      await disableAfterWriteFailure();
    }
  };

  return {
    get tracePath() {
      return tracePath;
    },
    warnings,
    write(event) {
      if (finalizing || finalized) {
        addWarning(AUDIT_WARNING_WRITE_AFTER_FINALIZE);
        return Promise.resolve();
      }
      const task = queue.then(() => writeOne(event));
      queue = task.catch(async () => {
        await disableAfterWriteFailure();
      });
      return task.catch(() => undefined);
    },
    finalize() {
      if (finalizePromise) return finalizePromise;
      finalizing = true;
      finalizePromise = queue
        .then(async () => {
          await closeHandle();
          finalized = true;
        })
        .catch(() => {
          disabled = true;
          addWarning(AUDIT_WARNING_FINALIZE_FAILED);
          finalized = true;
        });
      return finalizePromise;
    },
  };
}

async function writeFully(
  handle: FileHandle,
  buffer: Buffer,
  writeChunk: TraceWriterOptions["writeChunk"],
): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const bytesWritten = await (writeChunk ?? defaultWriteChunk)(
      handle,
      buffer,
      offset,
    );
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error("partial audit write could not advance");
    }
    offset += bytesWritten;
  }
}

async function defaultWriteChunk(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
): Promise<number> {
  const { bytesWritten } = await handle.write(
    buffer,
    offset,
    buffer.byteLength - offset,
    null,
  );
  return bytesWritten;
}

async function defaultCloseHandle(handle: FileHandle): Promise<void> {
  await handle.close();
}
