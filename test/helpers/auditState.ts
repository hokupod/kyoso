import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

export async function auditTracePath(options: {
  stateHome: string;
  cwd: string;
  directory: string;
  date: string;
  traceId: string;
}): Promise<string> {
  const [workspaceRoot, stateHome] = await Promise.all([
    realpath(options.cwd),
    realpath(options.stateHome),
  ]);
  const workspaceHash = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex");
  return join(
    stateHome,
    "kyoso",
    "workspaces",
    workspaceHash,
    ...options.directory.split("/"),
    options.date,
    `${options.traceId}.jsonl`,
  );
}
