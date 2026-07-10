---
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

## Workflow

1. Determine whether the user wants a plan review, security review, or diff review.
2. Summarize the user's goal.
3. Gather relevant context:
   - repo summary
   - current plan if available
   - selected files
   - unified diff if available
   - constraints
4. Run the review through the first available path:
   - Prefer the corresponding Kyoso MCP tool when it is available:
     - `plan_review`
     - `security_review`
     - `diff_review`
   - If the MCP tools are unavailable, use the CLI fallback with JSON output:
     - `plan_review` -> `npx -y @kyo-so/cli plan --goal <text> [--plan <path-or-text>] [--file <path>] --json`
     - `security_review` -> `npx -y @kyo-so/cli security --goal <text> [--diff <path>] [--file <path>] --json`
     - `diff_review` -> `npx -y @kyo-so/cli diff --base <ref> --head <ref> --json`
   - `bunx @kyo-so/cli` may be used instead of `npx -y @kyo-so/cli`.
   - The CLI also accepts `--repo-summary`, repeatable `--constraint`, and repeatable `--file` flags. For a large review, adjust an agent timeout with `--set agents.<agent>.timeoutMs=<ms>`.
   - Run the CLI without a config trust flag first. Inspect `audit.warnings` in the JSON result; if it contains `untrusted config was not executed`, or the command fails with an untrusted-config message, ask the user whether to rerun with `--trust-config` to use it or `--ignore-config` to skip it. Never add `--trust-config` without confirmation.
   - Keep `--json` enabled and interpret the returned `decision` exactly like the MCP result.
5. Treat `decision: block` as a stop signal. Present the result to the user before implementing.
6. Treat `decision: approve_with_changes` as requiring changes to the plan or implementation.
7. Do not claim Kyoso modified files. Kyoso only reviews.
