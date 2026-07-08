import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

type TrustedConfigStore = Record<string, string>;

export type ConfigTrustStatus =
  | "ignored"
  | "not_found"
  | "trusted"
  | "trusted_by_flag"
  | "trusted_interactively"
  | "untrusted_skipped";

export function hashConfigSource(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export function defaultTrustedConfigStorePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.KYOSO_TRUST_STORE_PATH
    ? resolve(env.KYOSO_TRUST_STORE_PATH)
    : join(
        env.HOME ? resolve(env.HOME) : homedir(),
        ".kyoso",
        "trusted-configs.json",
      );
}

export async function isTrustedConfig(
  storePath: string,
  configPath: string,
  configHash: string,
): Promise<boolean> {
  const store = await readTrustedConfigStore(storePath);
  return store[configPath] === configHash;
}

export async function trustConfig(
  storePath: string,
  configPath: string,
  configHash: string,
): Promise<void> {
  const store = await readTrustedConfigStore(storePath);
  store[configPath] = configHash;
  await mkdir(dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function readTrustedConfigStore(
  storePath: string,
): Promise<TrustedConfigStore> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (isMissingPathError(error)) return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  if (!isRecord(parsed)) return {};

  const store: TrustedConfigStore = {};
  for (const [configPath, configHash] of Object.entries(parsed)) {
    if (typeof configHash === "string") store[configPath] = configHash;
  }
  return store;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
