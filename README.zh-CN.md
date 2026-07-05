# Kyo-so

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

此翻译可能落后于英文版。请参阅英文 README 获取最新信息。

Kyo-so (Kyoso / 協奏) 是面向 AI coding workflows 的 MCP-native、ACP-powered multi-agent review gate。

日语词「協奏」在英语中可译为 concerto：多个独立演奏者各司其职，共同完成一部协调的作品。

它会协调 Codex 和 Claude reviewers，用于：

- implementation plan review
- 带有 CISA Secure by Design gates 的 security review
- 实现后的 diff review

Kyoso 不会应用代码更改。

## Quick Start

无需全局安装。通过 `npx` 或 `bunx` 运行 Kyoso。

### Claude Code

1. 准备 Claude authentication。

```bash
claude setup-token
```

设置该命令得到的 `CLAUDE_CODE_OAUTH_TOKEN`，或设置 `ANTHROPIC_API_KEY` 以使用 direct API billing。

2. 注册 MCP 并安装 review skill。

```bash
npx @kyo-so/cli setup claude-code --write
bunx @kyo-so/cli setup claude-code --write
```

3. 验证 setup。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. 从 Claude Code 请求 review。

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. 准备 Codex authentication。

```bash
codex login
```

2. 注册 MCP 并安装 review skill。

```bash
npx @kyo-so/cli setup codex --write
bunx @kyo-so/cli setup codex --write
```

3. 验证 setup。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. 从 Codex 请求 review。

```text
Use Kyoso diff_review on the current diff. I need a second opinion before merging.
```

手动 setup 示例保留在 `examples/codex-config.toml` 和 `examples/claude-code-mcp.json`。

## Install / Run

```bash
npx @kyo-so/cli mcp
bunx @kyo-so/cli mcp
```

Naming note: npm package 是 `@kyo-so/cli` (对应产品名 Kyo-so)，安装后的 CLI command 是更短的 `kyoso`。

本地开发：

```bash
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

运行打包后的 CLI 需要 Node.js 20 或更高版本。

已知分发风险：`@modelcontextprotocol/server` 目前还没有 stable release；Kyoso 当前 pin 了 prerelease API，因此 MCP SDK API 变更可能需要后续 release。

## CLI

`npx @kyo-so/cli` 和 `bunx @kyo-so/cli` 是正常执行路径。下面的示例将此前缀简写为 `kyoso`。

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

使用选定代码 review implementation plan：

```bash
kyoso plan \
  --goal "Review the OAuth callback implementation plan" \
  --plan plan.md \
  --file src/auth/callback.ts
```

按从上到下的顺序阅读结果：`Decision` 是 deterministic gate outcome，`Findings` 是 required changes，`Tests to Add` 是 Kyoso 在 approval 前期望的 regression checks。

对 patch 运行 CISA Secure by Design security review：

```bash
kyoso security \
  --goal "Review auth changes for tenant isolation and secure defaults" \
  --diff changes.patch \
  --json
```

在 JSON output 中，`cisaSecureByDesign` 会显示四个 gate dimensions。customer security outcomes 中的 `fail` 会 block review；warning-level dimensions 通常会产生 `approve_with_changes`。

将 Kyoso 注册为 Codex 或 Claude Code 的 MCP server，然后从 client 调用 `plan_review`：

```toml
# See examples/codex-config.toml
[mcp_servers.kyoso]
command = "npx"
args = ["-y", "@kyo-so/cli", "mcp", "--network", "model_only"]
```

client request 示例：

```text
Use Kyoso plan_review on this plan and the selected auth files. I need a second opinion before implementing.
```

## MCP

```bash
npx @kyo-so/cli mcp --network model_only
bunx @kyo-so/cli mcp --network model_only
```

省略 `--network` 时，Kyoso 使用 `model_only`。这意味着 Kyoso 期望 backend agents 只产生 model-provider traffic。这是 policy-level constraint，不是 OS-level network isolation。

Kyoso 只暴露以下 MCP tools：

- `plan_review`
- `security_review`
- `diff_review`

MCP stdout 专用于 protocol messages。Logs 会写到 stderr 或 local audit traces。

## Skill

内置的 `kyoso-review` skill 有意保持范围很窄。只有当你明确请求 Kyoso、multi-agent review、plan review、security review、CISA Secure by Design review 或 diff review 时，才应触发它。

`npx @kyo-so/cli setup codex --write` 和 `bunx @kyo-so/cli setup codex --write` 默认将其复制到 `.agents/skills/kyoso-review/`。添加 `--global` 会复制到 `~/.agents/skills/kyoso-review/`。

`npx @kyo-so/cli setup claude-code --write` 和 `bunx @kyo-so/cli setup claude-code --write` 默认将其复制到 `.claude/skills/kyoso-review/`。添加 `--global` 会复制到 `~/.claude/skills/kyoso-review/`。

## Safety Model

Kyoso MVP 使用 disposable temporary snapshot 和 policy-level write denial。它不是完整的 OS sandbox。除非你理解相关风险，否则不要针对 untrusted repositories 运行 Kyoso。

Secret detection 是 best-effort。如果 Kyoso 在 request、selected files 或 diff 中检测到疑似 secret，它会 redact 该值，并默认在 backend agents 运行前 block。

Kyoso 不存储 provider credentials。Child agent environment variables 使用 allowlist。

Repository content、plans、diffs 和 selected files 在 backend prompts 中被视为 untrusted data。Kyoso 会用 `<untrusted-content>` tags 包裹它们，并告诉 agents 不要遵循其中的 instructions。最终 decisions 来自 schema-constrained findings；agents 不能写 files 或运行 commands，judge 不能改变 deterministic decision。

## Agent Auth

可用时，Codex 使用 local `codex` login。默认 subscription-backed path 不需要 API key。

Claude 支持两种 auth paths：

- `ANTHROPIC_API_KEY`: direct Anthropic API billing
- `CLAUDE_CODE_OAUTH_TOKEN`: 来自 `claude setup-token` 的 subscription auth

如果同时设置了两个 Claude credentials，Kyoso 默认只将 `CLAUDE_CODE_OAUTH_TOKEN` forward 给 Claude child agent。若只想 forward `ANTHROPIC_API_KEY`，请设置 `agents.claude.auth.preferApiKey: true`。

Default child-agent env allowlist:

| Agent  | Provider env                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex  | `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_ACCESS_TOKEN`                                                                                                                        |
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` |

Kyoso 还会 forward 启动 subprocesses 所需的最小 runtime env：`PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `USERNAME`, and `SystemRoot`。

## Agent Models

省略 `agents.<name>.model` 时，会使用各 agent 自身的 default。Codex 使用 local Codex config，例如 `~/.codex/config.toml`；Claude 使用 adapter default。

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

Kyoso 会将 model pins 映射到 adapter-supported configuration：

- Claude: 当 `agents.claude.env` 或 whitelisted parent env 中尚未设置时，设置 `ANTHROPIC_MODEL`。
- Codex: 当 `CODEX_CONFIG` 尚未设置时，设置 `CODEX_CONFIG={"model":"..."}`。若要将 model pin 与其他 Codex session config 组合，请直接设置 `agents.codex.env.CODEX_CONFIG`。

## Audit

Audit traces 写入：

```text
.kyoso/traces/<yyyy-mm-dd>/<traceId>.jsonl
```

Raw agent output 和 raw file contents 默认禁用。

不要将 `.kyoso/traces/` 提交到 Git。`kyoso init` 会把 `.kyoso/` 添加到 `.gitignore`，本 repository 也同样如此。如果启用 `audit.includeRawAgentOutput`，traces 可能会保留 sensitive review output；请按照 local retention policy 定期删除旧 traces。

## Config

`kyoso.config.ts` 只会在 trust-on-first-use approval 之后 load。Trusted hashes 保存在 `~/.kyoso/trusted-configs.json`。

TypeScript config files 可以执行任意 code。在 TTY 中，Kyoso 会在执行 untrusted config 前提示确认。在 MCP 或 CI 等 non-interactive mode 中，untrusted config 会被 skip，并使用 defaults。传入 `--trust-config` 可明确 trust 当前 config hash；传入 `--ignore-config` 可始终使用 defaults。

Default agent timeouts 是 Codex 120 秒、Claude 240 秒。MCP clients 应允许 tool calls 至少运行 360 秒。

Judge LLMs 是 optional。设置 `OPENAI_API_KEY` 或 `CODEX_API_KEY` 可使用 OpenAI judge，设置 `ANTHROPIC_API_KEY` 可使用 Anthropic judge。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults 有意使用 lightweight models。若需要更强的 judge，请将 `KYOSO_ANTHROPIC_JUDGE_MODEL` 设置为 Sonnet-class model，例如 `claude-sonnet-5`。

Subscription-only setup:

- Codex: 使用 local `codex` login
- Claude: 运行 `claude setup-token`，然后设置 `CLAUDE_CODE_OAUTH_TOKEN`
- Judge: 不设置 API keys，因此 Kyoso 使用 `deterministic_fallback`
- 当存在 `OPENAI_API_KEY` 时，如需避免 OpenAI judge calls，请设置 `judgeProvider: "none"`

Team admins 还应检查 organization Usage credits。如果启用了 credits，超出 subscription limits 的 billing behavior 由 Kyoso 外部控制。

## Troubleshooting

- MCP timeout: 将 client tool timeouts 设置为至少 360 秒。Kyoso defaults 是 Codex 120 秒、Claude 240 秒。
- Fresh npm release: safe-chain 等 minimum-package-age protection 可能会在 publish 后短时间内 block `npx @kyo-so/cli` resolution。
- Non-interactive config: 除非传入 `--trust-config`，否则 untrusted `kyoso.config.ts` 会被 skip。

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents；不要在 production 中设置。
- `KYOSO_KEEP_TEMP=1`: 为 local debugging 保留 temporary snapshots。

## License

Kyoso 使用 GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) 授权。

Kyoso 设计为作为 separate CLI 或 MCP server process 使用。将 Kyoso embedding、importing 或 linking 到另一个 program 中，可能会产生不同的 license implications。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
