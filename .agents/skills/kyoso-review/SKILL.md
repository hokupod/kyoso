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
4. Call the appropriate Kyoso MCP tool:
   - `plan_review`
   - `security_review`
   - `diff_review`
5. Treat `decision: block` as a stop signal. Present the result to the user before implementing.
6. Treat `decision: approve_with_changes` as requiring changes to the plan or implementation.
7. Do not claim Kyoso modified files. Kyoso only reviews.

## Local development in this repository (kyoso itself)

When the Kyoso MCP server is not registered, run the CLI from source instead:

```bash
safe-chain bun run dev -- diff --diff <patch> --file <files...> --json --trust-config
safe-chain bun run dev -- plan --goal "<goal>" --plan <plan.md> --json --trust-config
safe-chain bun run dev -- security --goal "<goal>" --diff <patch> --json --trust-config
```

Always pass `--trust-config`, not `--ignore-config`. This repository's
`kyoso.config.ts` enables the verification round for dogfooding; `--ignore-config`
silently disables it. Never reuse `--trust-config` outside this repository.

When the JSON result contains findings with `verification.status` of `refuted` or
`confirmed`, mention them explicitly in your report so they can be recorded in
`ai/plans/active/2026-07-08-dogfooding計画.md`.
