# Kyo-so

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hokupod/kyoso)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Kyo-so (Kyoso / 協奏) is an MCP-native, ACP-powered multi-agent review gate for AI coding workflows.

The Japanese word 協奏 translates to concerto in English: multiple independent players performing one coordinated piece.

It coordinates Codex and Claude reviewers for:

- implementation plan review
- security review with CISA Secure by Design gates
- diff review after implementation

Kyoso does not apply code changes.

## Quick Start

No global install is required. Run Kyoso through `npx` or `bunx`.

### Claude Only / Codex Only

Kyoso can run when only Claude or only Codex is available. Disable the missing backend in `kyoso.config.ts` using `examples/claude-only.config.ts` or `examples/codex-only.config.ts`.

In single-agent mode, the remaining backend runs once as `combined_reviewer` and covers both implementation and architecture/security focus areas. JSON output includes `reviewMode: "single_agent"` and `agentsUsed`; Markdown output states that cross-model verification was not performed and marks disagreements as N/A.

This mode does not provide independent cross-model validation and may retain self-review bias. It still provides a separate read-only review process, temporary snapshots, adversarial review prompts, secret scanning, and deterministic gates.

### Claude Code

1. Prepare Claude authentication.

```bash
claude setup-token
```

Set `CLAUDE_CODE_OAUTH_TOKEN` from that command, or set `ANTHROPIC_API_KEY` for direct API billing.

2. Register MCP and install the review skill.

```bash
npx @kyo-so/cli setup claude-code --write
bunx @kyo-so/cli setup claude-code --write
```

3. Verify the setup.

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. Ask for a review from Claude Code.

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. Prepare Codex authentication.

```bash
codex login
```

2. Register MCP and install the review skill.

```bash
npx @kyo-so/cli setup codex --write
bunx @kyo-so/cli setup codex --write
```

3. Verify the setup.

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. Ask for a review from Codex.

```text
Use Kyoso diff_review on the current diff. I need a second opinion before merging.
```

Manual setup examples are kept in `examples/codex-config.toml` and `examples/claude-code-mcp.json`.

## Install / Run

```bash
npx @kyo-so/cli mcp
bunx @kyo-so/cli mcp
```

Naming note: the npm package is `@kyo-so/cli` (matching the product name Kyo-so), while the installed CLI command is the shorter `kyoso`.

For local development:

```bash
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

Requires Node.js 20 or newer when running the packaged CLI.

Known distribution risk: `@modelcontextprotocol/server` has no stable release yet; Kyoso currently pins a prerelease API, so MCP SDK API changes may require a follow-up release.

## CLI

`npx @kyo-so/cli` and `bunx @kyo-so/cli` are the normal execution paths. The examples below abbreviate that prefix as `kyoso`.

```bash
kyoso plan --goal "Review this OAuth callback plan" --plan plan.md
kyoso security --goal "Review this auth diff" --diff changes.patch
kyoso diff --base main --head HEAD
kyoso doctor
kyoso init
kyoso setup codex
kyoso setup claude-code
```

## Usage Examples

Review an implementation plan with selected code:

```bash
kyoso plan \
  --goal "Review the OAuth callback implementation plan" \
  --plan plan.md \
  --file src/auth/callback.ts
```

Read the result from the top down: `Decision` is the deterministic gate outcome, `Findings` are the required changes, and `Tests to Add` are the regression checks Kyoso expects before approval.

Run a CISA Secure by Design security review against a patch:

```bash
kyoso security \
  --goal "Review auth changes for tenant isolation and secure defaults" \
  --diff changes.patch \
  --json
```

In JSON output, `cisaSecureByDesign` shows the four gate dimensions. A `fail` in customer security outcomes blocks the review; warning-level dimensions usually produce `approve_with_changes`.

Register Kyoso with Codex or Claude Code as an MCP server, then call `plan_review` from the client:

```toml
# See examples/codex-config.toml
[mcp_servers.kyoso]
command = "npx"
args = ["-y", "@kyo-so/cli", "mcp", "--network", "model_only"]
```

Example client request:

```text
Use Kyoso plan_review on this plan and the selected auth files. I need a second opinion before implementing.
```

## MCP

```bash
npx @kyo-so/cli mcp --network model_only
bunx @kyo-so/cli mcp --network model_only
```

When `--network` is omitted, Kyoso uses `model_only`. This means Kyoso expects only model-provider traffic from backend agents. It is a policy-level constraint, not OS-level network isolation.

Kyoso exposes exactly these MCP tools:

- `plan_review`
- `security_review`
- `diff_review`

MCP stdout is reserved for protocol messages. Logs go to stderr or local audit traces.

## Skill

The bundled `kyoso-review` skill is intentionally narrow. It should trigger only when you explicitly ask for Kyoso, multi-agent review, plan review, security review, CISA Secure by Design review, or diff review.

`npx @kyo-so/cli setup codex --write` and `bunx @kyo-so/cli setup codex --write` copy it to `.agents/skills/kyoso-review/` by default. Add `--global` to copy it to `~/.agents/skills/kyoso-review/`.

`npx @kyo-so/cli setup claude-code --write` and `bunx @kyo-so/cli setup claude-code --write` copy it to `.claude/skills/kyoso-review/` by default. Add `--global` to copy it to `~/.claude/skills/kyoso-review/`.

## Safety Model

Kyoso MVP uses a disposable temporary snapshot and policy-level write denial. It is not a full OS sandbox. Do not run Kyoso against untrusted repositories unless you understand the risk.

Secret detection is best-effort. If Kyoso detects a likely secret in the request, selected files, or diff, it redacts the value and blocks before backend agents run by default.

Kyoso does not store provider credentials. Child agent environment variables are allowlisted.

Repository content, plans, diffs, and selected files are treated as untrusted data in backend prompts. Kyoso wraps them in `<untrusted-content>` tags and tells agents not to follow instructions found inside. Final decisions are derived from schema-constrained findings; agents cannot write files or run commands, and the judge cannot change the deterministic decision.

## Agent Auth

Codex uses the local `codex` login when available. No API key is required for the default subscription-backed path.

Claude supports two auth paths:

- `ANTHROPIC_API_KEY`: direct Anthropic API billing
- `CLAUDE_CODE_OAUTH_TOKEN`: subscription auth from `claude setup-token`

If both Claude credentials are set, Kyoso forwards only `CLAUDE_CODE_OAUTH_TOKEN` to the Claude child agent by default. Set `agents.claude.auth.preferApiKey: true` to forward only `ANTHROPIC_API_KEY`.

Default child-agent env allowlist:

| Agent  | Provider env                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex  | `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_ACCESS_TOKEN`                                                                                                                        |
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` |

Kyoso also forwards minimal runtime env needed to launch subprocesses: `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `USERNAME`, and `SystemRoot`.

## Agent Models

Omit `agents.<name>.model` to use each agent's own default. Codex uses the local Codex config, such as `~/.codex/config.toml`; Claude uses the adapter default.

```ts
export default defineConfig({
  agents: {
    codex: {
      model: "gpt-5.5",
    },
    claude: {
      model: "claude-sonnet-5",
    },
  },
});
```

Kyoso maps model pins to adapter-supported configuration:

- Claude: sets `ANTHROPIC_MODEL` when not already set in `agents.claude.env` or a whitelisted parent env.
- Codex: sets `CODEX_CONFIG={"model":"..."}` when `CODEX_CONFIG` is not already set. To combine other Codex session config with a model pin, set `agents.codex.env.CODEX_CONFIG` directly.

## Audit

Audit traces are written to:

```text
.kyoso/traces/<yyyy-mm-dd>/<traceId>.jsonl
```

Raw agent output and raw file contents are disabled by default.

Keep `.kyoso/traces/` out of Git. `kyoso init` adds `.kyoso/` to `.gitignore`, and this repository does the same. If `audit.includeRawAgentOutput` is enabled, traces may persist sensitive review output; delete old traces regularly according to your local retention policy.

## Config

`kyoso.config.ts` is loaded only after trust-on-first-use approval. Trusted hashes are stored in `~/.kyoso/trusted-configs.json`.

TypeScript config files can execute arbitrary code. In a TTY, Kyoso prompts before executing an untrusted config. In non-interactive mode such as MCP or CI, untrusted config is skipped and defaults are used. Pass `--trust-config` to explicitly trust the current config hash, or `--ignore-config` to always use defaults.

Default agent timeouts are Codex 120 seconds and Claude 240 seconds. MCP clients should allow at least 360 seconds for tool calls.

Judge LLMs are optional. Set `OPENAI_API_KEY` or `CODEX_API_KEY` to use the OpenAI judge, or `ANTHROPIC_API_KEY` to use the Anthropic judge. Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults intentionally use lightweight models. For a stronger judge, set `KYOSO_ANTHROPIC_JUDGE_MODEL` to a Sonnet-class model such as `claude-sonnet-5`.

Subscription-only setup:

- Codex: use local `codex` login
- Claude: run `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`
- Judge: set no API keys, so Kyoso uses `deterministic_fallback`
- To avoid OpenAI judge calls when `OPENAI_API_KEY` is present, set `judgeProvider: "none"`

Team admins should also check organization Usage credits. If credits are enabled, billing behavior beyond subscription limits is controlled outside Kyoso.

## Troubleshooting

- MCP timeout: set client tool timeouts to at least 360 seconds. Kyoso defaults are Codex 120 seconds and Claude 240 seconds.
- Fresh npm release: minimum-package-age protection in tools such as safe-chain may briefly block `npx @kyo-so/cli` resolution after publish.
- Non-interactive config: untrusted `kyoso.config.ts` is skipped unless you pass `--trust-config`.

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; do not set in production.
- `KYOSO_KEEP_TEMP=1`: keep temporary snapshots for local debugging.

## License

Kyoso is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).

Kyoso is intended to be used as a separate CLI or MCP server process. Embedding, importing, or linking Kyoso into another program may have different license implications.

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
