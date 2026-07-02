import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  const tracePath = join(options.cwd, options.directory, date, `${options.traceId}.jsonl`);
  return {
    tracePath,
    warnings,
    async write(event) {
      try {
        await mkdir(dirname(tracePath), { recursive: true });
        await appendFile(tracePath, `${JSON.stringify(sanitizeForAudit(event))}\n`, "utf8");
      } catch (error) {
        warnings.push(`Audit write failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
