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

### Integration modes

| Mode                | Installs                           | MCP | Clients             |
| ------------------- | ---------------------------------- | --: | ------------------- |
| Marketplace Plugin  | Skill plus local stdio MCP         | Yes | Codex / Claude Code |
| CLI plus Skill-only | npm CLI plus Skill                 |  No | Codex / Claude Code |
| Manual setup        | Manual MCP registration plus Skill | Yes | Codex / Claude Code |

When in doubt, pick the Marketplace Plugin: two commands install the Skill and the MCP server together. Follow the [Codex](#codex) or [Claude Code](#claude-code) steps below.

#### Marketplace Plugin

The Plugin bundles the Skill and an MCP definition pinned to an exact published Kyoso CLI version; it does not bundle the CLI itself. Its first MCP start needs network access to npm. A cached package may work offline, but offline startup is not guaranteed. The manifest's `Read` capability is display metadata, not additional filesystem authorization.

The Plugin Skill declares the bundled `kyoso` MCP server as a dependency, so explicit Kyoso reviews are directed through MCP rather than a CLI fallback. If you disable the bundled Plugin MCP, treat the Plugin Skill as unavailable: re-enable it, or remove the Plugin and install CLI plus Skill-only instead. The Plugin is not a CLI-fallback mode.

#### CLI plus Skill-only

```bash
# Global CLI and Codex Skill
npm install -g @kyo-so/cli
kyoso setup codex --write --skill-only --global

# Project CLI and Codex Skill
npm install -D @kyo-so/cli
npx kyoso setup codex --write --skill-only
```

Replace `codex` with `claude-code` for Claude Code. Dry-run remains the default. `--skill-only` never reads or writes MCP configuration and cannot be combined with `--runner` or `--command`.

Skill-only intentionally does not declare an MCP dependency. When it reaches an `npx` or `bunx` package-runner fallback, Codex Auto mode can request a sandbox network escalation approval; installing `kyoso` on `PATH` avoids that fallback.

#### Migration

- Manual MCP to CLI plus Skill: install the CLI and Skill first, then run `codex mcp remove kyoso` or `claude mcp remove kyoso --scope local|project|user`.
- CLI plus Skill to Plugin: add the Plugin, confirm it is enabled, then remove the manual MCP registration. Manually copied Skills are not removed automatically.
- Plugin to CLI plus Skill: install the CLI and Skill first, then run `codex plugin remove kyoso@kyoso`.
- CLI plus Skill back to manual MCP: run `kyoso setup codex --write` or `kyoso setup claude-code --write`.

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

2. Install the Marketplace Plugin (recommended).

```text
/plugin marketplace add hokupod/kyoso
/plugin install kyoso@kyoso
```

The Plugin installs the Kyoso review Skill and a local stdio MCP server pinned to a released CLI version. When you install the Plugin, `kyoso setup claude-code` is not required.

3. Alternatively, register MCP and install the review skill.

```bash
npx @kyo-so/cli setup claude-code --write
bunx @kyo-so/cli setup claude-code --write
```

For manual MCP registration, use `examples/claude-code-mcp.json`.

4. Verify the setup.

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

5. Ask for a review from Claude Code.

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. Prepare Codex authentication.

```bash
codex login
```

2. Install the Marketplace Plugin (recommended).

```bash
codex plugin marketplace add hokupod/kyoso
codex plugin add kyoso@kyoso
```

You can also select Kyoso from the Codex desktop Plugins page or `/plugins`; refresh or restart the desktop app if a newly added marketplace is not visible. Check the installation with `codex plugin list --marketplace kyoso --json`, and remove the Plugin with `codex plugin remove kyoso@kyoso`. When you install the Plugin, `kyoso setup codex` is not required.

In Codex Auto mode, the first MCP invocation can still require approval because Kyoso tools do not declare annotations; choose "Allow and don't ask me again" to retain that approval.

3. Alternatively, register MCP and install the review skill.

```bash
npx @kyo-so/cli setup codex --write
bunx @kyo-so/cli setup codex --write
```

4. Verify the setup.

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

5. Ask for a review from Codex.

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
kyoso diff --base main --head HEAD --set agents.claude.effort=high
kyoso doctor
kyoso init
kyoso setup codex
kyoso setup claude-code
kyoso setup codex --write --skill-only
kyoso setup claude-code --write --skill-only
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

The Skill uses the first available path: Kyoso MCP tools, an installed `kyoso` on `PATH`, `npx -y @kyo-so/cli`, then `bunx @kyo-so/cli`. The package-runner fallbacks may need network access and can drift to a newer version, so an installed CLI is the normal MCP-less path.

`kyoso setup codex --write --skill-only` copies the canonical Skill directory to `.agents/skills/kyoso-review/` by default. Add `--global` to copy it to `~/.agents/skills/kyoso-review/`.

`kyoso setup claude-code --write --skill-only` copies it to `.claude/skills/kyoso-review/` by default. Add `--global` to copy it to `~/.claude/skills/kyoso-review/`.

Managed installs record the canonical directory digest and CLI version in `.kyoso-install.json`. Exact current or known historical copies are adopted and updated automatically. A changed or unknown copy is reported as a conflict and left untouched; `--force` replaces only that Skill directory and never removes or overwrites MCP configuration.

## Safety Model

Kyoso MVP uses a disposable temporary snapshot and policy-level write denial. It is not a full OS sandbox. Do not run Kyoso against untrusted repositories unless you understand the risk.

Secret detection is best-effort. If Kyoso detects a likely secret in the request, selected files, or diff, it redacts the value and blocks before backend agents run by default.

Kyoso does not store provider credentials. Child agent environment variables are allowlisted.

Repository content, plans, diffs, and selected files are treated as untrusted data in backend prompts. Kyoso wraps them in `<untrusted-content>` tags and tells agents not to follow instructions found inside. Final decisions are derived from schema-constrained findings; agents cannot write files or run commands, and the judge cannot change the deterministic decision.

Finding titles are normalized to concise English for aggregation; evidence, recommendations, and summaries can remain in the user's language.

Audit traces use a trusted user state root rather than a workspace-controlled path. On supported POSIX runtimes, Kyoso uses an absolute `$XDG_STATE_HOME` when available, otherwise `$HOME/.local/state`, only after ownership, permission, containment, and symlink checks succeed. It never silently falls back to another location: if verification or safe open fails, Audit writing is disabled for that review and a sanitized warning is returned while the review continues.

Windows, and environments where the required filesystem capabilities cannot be proven, disable Audit writing fail closed. A hostile process running as the same OS user that can modify the trusted state root or rename an already verified inode is outside this guarantee; protecting against that threat requires an OS sandbox or native dirfd-based support.

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

## Agent Models and Effort

Omit `agents.<name>.model` or `agents.<name>.effort` to use each agent's own default. Codex uses the local Codex config, such as `~/.codex/config.toml`; Claude uses the adapter default.

For available model names, see the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview) and the [Codex models list](https://developers.openai.com/codex/models).

```toml
[agents.codex]
model = "gpt-5.5"
effort = "medium"

[agents.claude]
model = "claude-sonnet-5"
effort = "high"
```

Kyoso maps model pins to adapter-supported configuration:

- Claude: sets `ANTHROPIC_MODEL` when not already set in `agents.claude.env` or a whitelisted parent env.
- Codex: sets `CODEX_CONFIG={"model":"..."}` when `CODEX_CONFIG` is not already set. To combine other Codex session config with a model pin, set `agents.codex.env.CODEX_CONFIG` directly.

Effort works differently: Kyoso does not set an env var for it. Instead, it sends an ACP `session/set_config_option` request to the backend agent once per session, before the first prompt: `configId: "effort"` for Claude, `configId: "reasoning_effort"` for Codex. Valid values depend on the backend agent version and the selected model (for example, Claude only exposes effort levels for models that support them). Kyoso does not validate `effort` values itself; if the backend agent rejects the request or does not support it, Kyoso logs it to stderr and continues the review.

## Audit

On supported POSIX runtimes, Audit traces are written below the user state base (`$XDG_STATE_HOME` when absolute, otherwise `$HOME/.local/state`):

```text
<state-base>/kyoso/workspaces/<sha256(realpath(cwd))>/<logical audit.directory>/<yyyy-mm-dd>/<traceId>.jsonl
```

`audit.directory` is a logical relative directory (default: `.kyoso/traces`), not a directory in the workspace. Existing workspace `.kyoso/traces` files are not migrated or deleted automatically.

Raw agent output and raw file contents are disabled by default. If `audit.includeRawAgentOutput` is enabled, traces may persist sensitive review output; delete old traces according to your local retention policy. On Windows or an environment without proven safe filesystem capabilities, Audit trace writing stays disabled and the review returns a sanitized warning.

## Config

Kyoso loads config in this order:

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`, or `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- CLI flags such as `--network` and repeatable overrides such as `--set agents.claude.effort=high`

`plan`, `security`, and `diff` accept repeatable `--set <key>=<value>` overrides. Values set on the CLI take precedence over config files, including when `--ignore-config` is used.

- Agent keys: `agents.<codex|claude>.<enabled|model|effort|role|timeoutMs>`
- Verification keys: `verification.<enabled|maxFindings|timeoutMs>`
- Judge keys: `judge.<mode|provider|timeoutMs>`

Unknown keys are rejected. Boolean and numeric config keys are converted to their schema types; string keys remain strings. The complete config is then validated.

Project `kyoso.toml` is declarative and does not require trust approval. It can set safe project-scoped keys such as tool toggles, agent `enabled` / `model` / `effort` / `role` / `timeoutMs`, workspace byte limits and additive `workspace.deny`, verification settings, advisory judge settings, and tightening-only security/network settings.

Global TOML is for user-owned settings that can launch commands or forward environment variables:

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` is deprecated but still supported for compatibility. It is loaded only after trust-on-first-use approval; trusted hashes are stored in `~/.kyoso/trusted-configs.json`. If both `kyoso.toml` and `kyoso.config.ts` exist, Kyoso uses TOML and ignores the TypeScript config.

Default agent timeouts are Codex 120 seconds and Claude 300 seconds. MCP clients should allow at least 360 seconds for tool calls. If `verification.enabled` is true, allow at least 480 seconds because Kyoso may run an additional cross-agent verification round.

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

- MCP timeout: set client tool timeouts to at least 360 seconds, or at least 480 seconds when `verification.enabled` is true. Kyoso defaults are Codex 120 seconds, Claude 300 seconds, and verification 90 seconds.
- Fresh npm release: minimum-package-age protection in tools such as safe-chain may briefly block `npx @kyo-so/cli` resolution after publish.
- Deprecated TypeScript config: untrusted `kyoso.config.ts` is skipped unless you pass `--trust-config`; prefer `kyoso.toml`.

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; do not set in production.
- `KYOSO_KEEP_TEMP=1`: keep temporary snapshots for local debugging.

## License

Kyoso is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).

Kyoso is intended to be used as a separate CLI or MCP server process. Embedding, importing, or linking Kyoso into another program may have different license implications.

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
