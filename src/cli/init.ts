import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileWithOverwritePrompt } from "./io.js";

export async function runInit(options: {
  cwd: string;
  force: boolean;
}): Promise<string> {
  const configPath = join(options.cwd, "kyoso.config.ts");
  const skillPath = join(options.cwd, ".agents/skills/kyoso-review/SKILL.md");
  const gitignorePath = join(options.cwd, ".gitignore");
  const configResult = await writeFileWithOverwritePrompt(
    configPath,
    CONFIG_TEMPLATE,
    options.force,
  );
  const skillResult = await writeFileWithOverwritePrompt(
    skillPath,
    SKILL_TEMPLATE,
    options.force,
  );
  const gitignoreResult = await ensureGitignoreEntry(gitignorePath, ".kyoso/");
  return [
    `kyoso.config.ts: ${configResult}`,
    `.agents/skills/kyoso-review/SKILL.md: ${skillResult}`,
    `.gitignore .kyoso/: ${gitignoreResult}`,
  ].join("\n");
}

async function ensureGitignoreEntry(
  path: string,
  entry: string,
): Promise<"created" | "updated" | "already present"> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    await writeFile(path, `${entry}\n`, "utf8");
    return "created";
  }
  const lines = content.split(/\r?\n/);
  if (lines.includes(entry)) return "already present";
  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(path, `${content}${separator}${entry}\n`, "utf8");
  return "updated";
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const CONFIG_TEMPLATE = `import { defineConfig } from "@kyo-so/cli";

export default defineConfig({
  network: {
    defaultMode: "model_only",
  },
});
`;

const SKILL_TEMPLATE = `---
name: kyoso-review
description: Use Kyoso when the user explicitly asks for multi-agent plan review, security review, CISA Secure by Design review, diff review, or a second opinion from Codex and Claude. Do not invoke implicitly unless the user clearly requests Kyoso or multi-agent review.
---

# Kyoso Review

Kyoso is a multi-agent review gate for AI coding workflows. It coordinates Codex and Claude through ACP and returns a structured plan, security, or diff review.

Use this skill when the user explicitly asks for:

- Kyoso
- multi-agent review
- plan review
- security review
- CISA Secure by Design review
- diff review
- second opinion from Codex and Claude

Do not use this skill for every coding task. It is intended for deliberate review checkpoints.
`;
