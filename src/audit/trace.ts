import { mkdir, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { normalizeRelativePath } from "../context/pathPolicy.js";
import { sanitizeForAudit } from "./sanitize.js";

export type TraceWriter = {
  tracePath?: string;
  warnings: string[];
  write(event: Record<string, unknown>): Promise<void>;
};

export function createTraceWriter(options: {
  enabled: boolean;
  directory: string;
  traceId: string;
  cwd: string;
  includeRawAgentOutput?: boolean;
}): TraceWriter {
  const warnings: string[] = [];
  if (!options.enabled) {
    return {
      warnings,
      async write() {
        return;
      },
    };
  }
  const date = new Date().toISOString().slice(0, 10);
  const directory = validateAuditDirectory(options.directory, warnings);
  const tracePath = join(
    options.cwd,
    directory,
    date,
    `${options.traceId}.jsonl`,
  );
  return {
    tracePath,
    warnings,
    async write(event) {
      try {
        await mkdir(dirname(tracePath), { recursive: true });
        await appendFile(
          tracePath,
          `${JSON.stringify(
            sanitizeForAudit(event, {
              includeRawAgentOutput: options.includeRawAgentOutput,
            }),
          )}\n`,
          "utf8",
        );
      } catch (error) {
        warnings.push(
          `Audit write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function validateAuditDirectory(directory: string, warnings: string[]): string {
  try {
    if (isAbsolute(directory) || directory.split(/[\\/]+/).includes("..")) {
      throw new Error("unsafe path");
    }
    return normalizeRelativePath(directory);
  } catch {
    warnings.push(`Unsafe audit directory ignored: ${directory}`);
    return ".kyoso/traces";
  }
}
