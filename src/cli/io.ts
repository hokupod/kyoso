import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function readPathOrText(
  value: string | undefined,
): Promise<string | undefined> {
  if (!value) return undefined;
  if (await exists(value)) return readFile(value, "utf8");
  return value;
}

export async function readSelectedFiles(
  paths: string[],
): Promise<Array<{ path: string; language?: string; content: string }>> {
  return Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, "utf8");
      const language = languageFromPath(path);
      return { path, language, content };
    }),
  );
}

export async function writeFileWithOverwritePrompt(
  path: string,
  content: string,
  force: boolean,
): Promise<"created" | "skipped"> {
  if ((await exists(path)) && !force) {
    if (!process.stdin.isTTY)
      throw new Error(
        `Refusing to overwrite ${path}; pass --force in non-interactive mode.`,
      );
    const rl = createInterface({ input, output });
    const answer = await rl.question(`Overwrite ${path}? [y/N] `);
    rl.close();
    if (!/^y(?:es)?$/i.test(answer.trim())) return "skipped";
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return "created";
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function languageFromPath(path: string): string | undefined {
  const ext = extname(path).slice(1);
  if (!ext) return undefined;
  if (ext === "ts" || ext === "tsx") return "typescript";
  if (ext === "js" || ext === "jsx") return "javascript";
  if (ext === "md") return "markdown";
  return ext;
}
