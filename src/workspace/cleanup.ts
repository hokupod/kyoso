import { rm } from "node:fs/promises";

export async function cleanupSnapshot(path: string): Promise<void> {
  if (process.env.KYOSO_KEEP_TEMP === "1") return;
  await rm(path, { recursive: true, force: true });
}
