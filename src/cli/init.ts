import { join } from "node:path";
import { writeFileWithOverwritePrompt } from "./io.js";

export async function runInit(options: { cwd: string; force: boolean }): Promise<string> {
  const configPath = join(options.cwd, "kyoso.config.ts");
  const skillPath = join(options.cwd, ".agents/skills/kyoso-review/SKILL.md");
  const configResult = await writeFileWithOverwritePrompt(configPath, CONFIG_TEMPLATE, options.force);
  const skillResult = await writeFileWithOverwritePrompt(skillPath, SKILL_TEMPLATE, options.force);
  return [`kyoso.config.ts: ${configResult}`, `.agents/skills/kyoso-review/SKILL.md: ${skillResult}`].join("\n");
}

const CONFIG_TEMPLATE = `import { defineConfig } from "@kyoso/cli";

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
