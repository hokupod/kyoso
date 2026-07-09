# Kyo-so

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hokupod/kyoso)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

Kyo-so (Kyoso / 協奏) is an MCP-native, ACP-powered multi-agent review gate for AI coding workflows.

The Japanese word 協奏 translates to concerto in English: multiple independent players performing one coordinated piece.

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-ensemble.png" alt="A conductor coordinating a drummer, a violinist, and a pianist" width="480">
</p>

It coordinates Codex and Claude reviewers for:

- implementation plan review
- security review with CISA Secure by Design gates
- diff review after implementation

Kyoso does not apply code changes.

## Review Flow

All three review tools run the same pipeline: scan for secrets, snapshot the workspace read-only, run the reviewer ensemble in parallel over ACP, then aggregate findings, apply gates, and decide.

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-review-flow.en.svg" alt="Kyo-so review execution flow, from MCP/CLI request through secret scan, snapshot, ensemble review, aggregation, gates, and final decision" width="640">
</p>

With a single backend enabled, one agent runs as `combined_reviewer` instead of the two-role ensemble. The Mermaid sources for this diagram live in [docs/assets/](docs/assets/).

## Quick Start

No global install is required. Run Kyoso through `npx` or `bunx`.

### Claude Only / Codex Only

Kyoso can run when only Claude or only Codex is available. Disable the missing backend in `kyoso.toml` using `examples/claude-only.toml` or `examples/codex-only.toml`.

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
nix develop
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
safe-chain bun run pack:verify
```

Requires Node.js 20 or newer when running the packaged CLI.

The Nix dev shell pins Node.js 24 and the nixpkgs-provided Bun version. After reviewing `.envrc`, you can also run `direnv allow` once and let it load the shell automatically. CI remains pinned to Bun 1.3.14; the current nixpkgs Bun version may differ slightly, but `flake.lock` keeps local shells reproducible.

The test suite includes credential-free MCP stdio and ACP subprocess integration coverage. `pack:verify` additionally starts the packed `dist/bin/kyoso.js` MCP server and checks the published bundle's protocol handshake.

Known distribution risk: `@modelcontextprotocol/server` has no stable release yet; Kyoso currently pins a prerelease API, so MCP SDK API changes may require a follow-up release. Run manual real-agent dogfooding before releases that bump `@modelcontextprotocol/server`, `@agentclientprotocol/sdk`, or pinned ACP adapters.

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

Finding titles are normalized to concise English for aggregation; evidence, recommendations, and summaries can remain in the user's language.

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

For available model names, see the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and the [Codex models list](https://developers.openai.com/codex/models).

```toml
[agents.codex]
model = "gpt-5.5"

[agents.claude]
model = "claude-sonnet-5"
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

Kyoso loads config in this order:

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`, or `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- CLI flags such as `--network`

Project `kyoso.toml` is declarative and does not require trust approval. It can set safe project-scoped keys such as tool toggles, agent `enabled` / `model` / `role` / `timeoutMs`, workspace byte limits and additive `workspace.deny`, verification settings, advisory judge settings, and tightening-only security/network settings.

Global TOML is for user-owned settings that can launch commands or forward environment variables:

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` is deprecated but still supported for compatibility. It is loaded only after trust-on-first-use approval; trusted hashes are stored in `~/.kyoso/trusted-configs.json`. If both `kyoso.toml` and `kyoso.config.ts` exist, Kyoso uses TOML and ignores the TypeScript config.

Default agent timeouts are Codex 120 seconds and Claude 240 seconds. MCP clients should allow at least 360 seconds for tool calls. If `verification.enabled` is true, allow at least 480 seconds because Kyoso may run an additional cross-agent verification round.

Optional finding verification is disabled by default:

```toml
[verification]
enabled = false
maxFindings = 5
timeoutMs = 90000
# global config only; project kyoso.toml cannot set this
allowDemotion = false
```

When enabled, Kyoso asks the agent that did not report each high/critical single-source finding to try to refute it. Phase 1 is annotate-only: verification can update finding confidence and notes, but it does not change severity or the final decision. `allowDemotion` is reserved for a future opt-in phase and is currently a no-op.

Judge LLMs are optional. Set `OPENAI_API_KEY` or `CODEX_API_KEY` to use the OpenAI judge, or `ANTHROPIC_API_KEY` to use the Anthropic judge. Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults intentionally use lightweight models. For a stronger judge, set `KYOSO_ANTHROPIC_JUDGE_MODEL` to a Sonnet-class model such as `claude-sonnet-5`.

Subscription-only setup:

- Codex: use local `codex` login
- Claude: run `claude setup-token`, then set `CLAUDE_CODE_OAUTH_TOKEN`
- Judge: set no API keys, so Kyoso uses `deterministic_fallback`
- To avoid OpenAI judge calls when `OPENAI_API_KEY` is present, set `judge.provider = "none"`

Team admins should also check organization Usage credits. If credits are enabled, billing behavior beyond subscription limits is controlled outside Kyoso.

## Troubleshooting

- MCP timeout: set client tool timeouts to at least 360 seconds, or at least 480 seconds when `verification.enabled` is true. Kyoso defaults are Codex 120 seconds, Claude 240 seconds, and verification 90 seconds.
- Fresh npm release: minimum-package-age protection in tools such as safe-chain may briefly block `npx @kyo-so/cli` resolution after publish.
- Deprecated TypeScript config: untrusted `kyoso.config.ts` is skipped unless you pass `--trust-config`; prefer `kyoso.toml`.

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; do not set in production.
- `KYOSO_KEEP_TEMP=1`: keep temporary snapshots for local debugging.

## License

Kyoso is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).

Kyoso is intended to be used as a separate CLI or MCP server process. Embedding, importing, or linking Kyoso into another program may have different license implications.

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
