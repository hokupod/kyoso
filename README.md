# Kyo-so

Kyo-so (Kyoso / 協奏) is an MCP-native, ACP-powered multi-agent review gate for AI coding workflows.

The Japanese word 協奏 translates to concerto in English: multiple independent players performing one coordinated piece.

It coordinates Codex and Claude reviewers for:

- implementation plan review
- security review with CISA Secure by Design gates
- diff review after implementation

Kyoso does not apply code changes.

## Install

```bash
bunx @kyoso/cli mcp
npx @kyoso/cli mcp
```

For local development:

```bash
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

## CLI

```bash
kyoso plan --goal "Review this OAuth callback plan" --plan plan.md
kyoso security --goal "Review this auth diff" --diff changes.patch
kyoso diff --base main --head HEAD
kyoso doctor
kyoso init
```

## MCP

```bash
kyoso mcp
```

Kyoso exposes exactly these MCP tools:

- `plan_review`
- `security_review`
- `diff_review`

MCP stdout is reserved for protocol messages. Logs go to stderr or local audit traces.

## Safety Model

Kyoso MVP uses a disposable temporary snapshot and policy-level write denial. It is not a full OS sandbox. Do not run Kyoso against untrusted repositories unless you understand the risk.

Secret detection is best-effort. If Kyoso detects a likely secret in the request, selected files, or diff, it redacts the value and blocks before backend agents run by default.

Kyoso does not store provider credentials. Child agent environment variables are allowlisted.

## Audit

Audit traces are written to:

```text
.kyoso/traces/<yyyy-mm-dd>/<traceId>.jsonl
```

Raw agent output and raw file contents are disabled by default.

## Config

`kyoso.config.ts` is loaded from the current directory unless `--ignore-config` is passed.

TypeScript config files can execute arbitrary code. Do not run Kyoso in untrusted repositories without `--ignore-config`.

## License

Kyoso is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).

Kyoso is intended to be used as a separate CLI or MCP server process. Embedding, importing, or linking Kyoso into another program may have different license implications.

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
