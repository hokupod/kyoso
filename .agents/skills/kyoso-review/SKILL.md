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
