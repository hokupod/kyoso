import { readFile } from "node:fs/promises";
import { parse, TomlError } from "smol-toml";

export async function loadTomlConfigFile(configPath: string): Promise<unknown> {
  const source = await readFile(configPath, "utf8");
  try {
    return parse(source);
  } catch (error) {
    throw new Error(formatTomlError(configPath, error));
  }
}

function formatTomlError(configPath: string, error: unknown): string {
  if (error instanceof TomlError) {
    return `TOML config parse failed for ${configPath} at ${error.line}:${error.column}: ${error.message}`;
  }
  return `TOML config parse failed for ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
}
