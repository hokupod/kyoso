# Kyo-so

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hokupod/kyoso)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

此翻译可能落后于英文版。请参阅英文 README 获取最新信息。

Kyo-so (Kyoso / 協奏) 是面向 AI coding workflows 的 MCP-native、ACP-powered multi-agent review gate。

日语词「協奏」在英语中可译为 concerto：多个独立演奏者各司其职，共同完成一部协调的作品。

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-ensemble.png" alt="指挥家协调鼓手、小提琴手和钢琴家" width="480">
</p>

它会协调 Codex 和 Claude reviewers，用于：

- implementation plan review
- 带有 CISA Secure by Design gates 的 security review
- 实现后的 diff review

Kyoso 不会应用代码更改。

## Review Flow

三个 review tool 都运行同一条流水线：先进行 secret scan，在 read-only 的临时快照上通过 ACP 并行运行 reviewer ensemble，然后聚合发现、应用门禁并作出决定。

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-review-flow.zh-CN.svg" alt="Kyo-so 评审执行流程：从 MCP/CLI 请求到 secret scan、快照、协奏评审、聚合、门禁与最终决定" width="640">
</p>

当只启用一个 backend 时，会由 1 个 agent 以 `combined_reviewer` 运行，替代双角色 ensemble。此图的 Mermaid 源文件位于 [docs/assets/](docs/assets/)。

## Quick Start

无需全局安装。通过 `npx` 或 `bunx` 运行 Kyoso。

### 集成模式

| 模式               | 安装内容             | MCP | 客户端             |
| ------------------ | -------------------- | --: | ------------------ |
| Marketplace Plugin | Skill＋本地stdio MCP |  有 | Codex／Claude Code |
| CLI＋Skill-only    | npm CLI＋Skill       |  无 | Codex／Claude Code |
| 手动setup          | 手动MCP注册＋Skill   |  有 | Codex／Claude Code |

拿不准时请选择Marketplace Plugin：两条命令即可同时安装Skill和MCP server。步骤见下方的[Codex](#codex)／[Claude Code](#claude-code)小节。

#### Marketplace Plugin

Plugin包含Skill和pin到已发布Kyoso CLI精确版本的MCP定义，但不包含CLI本体。MCP首次启动需要访问npm网络。已缓存的package可能可以offline启动，但不作保证。manifest中的`Read` capability仅是显示metadata，不会授予额外filesystem权限。

Plugin中的Skill将内置的`kyoso` MCP server声明为dependency，因此显式Kyoso review会通过MCP而不是CLI fallback。如果禁用内置Plugin MCP，应将Plugin Skill视为不可用：重新启用MCP，或移除Plugin并改用CLI＋Skill-only。Plugin不是CLI fallback mode。

#### CLI＋Skill-only

```bash
# Global CLI＋Codex Skill
npm install -g @kyo-so/cli
kyoso setup codex --write --skill-only --global

# Project CLI＋Codex Skill
npm install -D @kyo-so/cli
npx kyoso setup codex --write --skill-only
```

Claude Code请将`codex`替换为`claude-code`。默认仍为dry-run。`--skill-only`不会读写MCP配置，也不能与`--runner`／`--command`组合使用。

Skill-only有意不声明MCP dependency。当它到达`npx`或`bunx`的package-runner fallback时，Codex Auto mode可能要求sandbox network escalation approval；在PATH上安装`kyoso`可以避免该fallback。

#### 迁移

- 从手动MCP迁移到CLI＋Skill：先安装CLI和Skill，再运行`codex mcp remove kyoso`或`claude mcp remove kyoso --scope local|project|user`。
- 从CLI＋Skill迁移到Plugin：添加Plugin并确认enabled后，再删除手动MCP注册。手动复制的Skill不会自动删除。
- 从Plugin迁移到CLI＋Skill：先安装CLI和Skill，再运行`codex plugin remove kyoso@kyoso`。
- 从CLI＋Skill恢复到手动MCP：运行`kyoso setup codex --write`或`kyoso setup claude-code --write`。

### Claude Only / Codex Only

Kyoso 可以在只有 Claude 或只有 Codex 可用时运行。请在 `kyoso.toml` 中禁用缺失的 backend；示例见 `examples/claude-only.toml` 和 `examples/codex-only.toml`。

在 single-agent mode 中，剩余 backend 会以 `combined_reviewer` 运行一次，同时覆盖 implementation 和 architecture/security 两类关注点。JSON output 会包含 `reviewMode: "single_agent"` 和 `agentsUsed`；Markdown output 会说明未执行 cross-model verification，并将 disagreements 标记为 N/A。

该 mode 不提供独立的 cross-model validation，仍可能有 self-review bias。它仍保留独立只读 review process、temporary snapshots、adversarial review prompts、secret scanning 和 deterministic gates。

### Claude Code

1. 准备 Claude authentication。

```bash
claude setup-token
```

设置该命令得到的 `CLAUDE_CODE_OAUTH_TOKEN`，或设置 `ANTHROPIC_API_KEY` 以使用 direct API billing。

2. 安装 Marketplace Plugin(推荐)。

```text
/plugin marketplace add hokupod/kyoso
/plugin install kyoso@kyoso
```

Plugin 会安装 Kyoso review Skill 和 pin 到已发布 CLI version 的本地 stdio MCP server。通过 Plugin 安装时，无需运行 `kyoso setup claude-code`。

3. 或者，注册 MCP 并安装 review skill。

```bash
npx @kyo-so/cli setup claude-code --write
bunx @kyo-so/cli setup claude-code --write
```

需要手动注册 MCP 时，请使用 `examples/claude-code-mcp.json`。

4. 验证 setup。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

5. 从 Claude Code 请求 review。

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. 准备 Codex authentication。

```bash
codex login
```

2. 安装 Marketplace Plugin(推荐)。

```bash
codex plugin marketplace add hokupod/kyoso
codex plugin add kyoso@kyoso
```

也可以在Codex desktop的Plugins page或`/plugins`中选择Kyoso。若新添加的Marketplace未显示，请refresh／restart desktop app。使用`codex plugin list --marketplace kyoso --json`确认安装，使用`codex plugin remove kyoso@kyoso`删除Plugin。通过 Plugin 安装时，无需运行 `kyoso setup codex`。

在Codex Auto mode中，Kyoso tools未声明annotations，首次MCP调用仍可能需要approval；选择“Allow and don't ask me again”即可保留该许可。

3. 或者，注册 MCP 并安装 review skill。

```bash
npx @kyo-so/cli setup codex --write
bunx @kyo-so/cli setup codex --write
```

4. 验证 setup。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

5. 从 Codex 请求 review。

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
nix develop
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

运行打包后的 CLI 需要 Node.js 20 或更高版本。

Nix dev shell 会 pin Node.js 24 和 nixpkgs 提供的 Bun version。确认 `.envrc` 后，也可以运行一次 `direnv allow`，让它自动加载 shell。CI 仍然 pin 到 Bun 1.3.14；当前 nixpkgs Bun version 可能略有不同，但 `flake.lock` 会保证 local shell 可复现。

已知分发风险：`@modelcontextprotocol/server` 目前还没有 stable release；Kyoso 当前 pin 了 prerelease API，因此 MCP SDK API 变更可能需要后续 release。

## CLI

`npx @kyo-so/cli` 和 `bunx @kyo-so/cli` 是正常执行路径。下面的示例将此前缀简写为 `kyoso`。

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

Skill使用第一个可用路径，顺序是Kyoso MCP tools、PATH上已安装的`kyoso`、`npx -y @kyo-so/cli`、`bunx @kyo-so/cli`。package runner fallback可能需要network access，也可能发生version drift，因此MCP-less正常路径应使用已安装CLI。

`kyoso setup codex --write --skill-only`默认将canonical Skill directory复制到`.agents/skills/kyoso-review/`。添加`--global`后复制到`~/.agents/skills/kyoso-review/`。

`kyoso setup claude-code --write --skill-only`默认复制到`.claude/skills/kyoso-review/`。添加`--global`后复制到`~/.claude/skills/kyoso-review/`。

managed install会把canonical directory digest和CLI version记录到`.kyoso-install.json`。当前或已知historical copy会被adopt并自动更新；修改过或未知的copy会报告conflict并保持不变。`--force`只替换该Skill directory，不会删除或覆盖MCP配置。

## Safety Model

Kyoso MVP 使用 disposable temporary snapshot 和 policy-level write denial。它不是完整的 OS sandbox。除非你理解相关风险，否则不要针对 untrusted repositories 运行 Kyoso。

Secret detection 是 best-effort。如果 Kyoso 在 request、selected files 或 diff 中检测到疑似 secret，它会 redact 该值，并默认在 backend agents 运行前 block。

Kyoso 不存储 provider credentials。Child agent environment variables 使用 allowlist。

Repository content、plans、diffs 和 selected files 在 backend prompts 中被视为 untrusted data。Kyoso 会用 `<untrusted-content>` tags 包裹它们，并告诉 agents 不要遵循其中的 instructions。最终 decisions 来自 schema-constrained findings；agents 不能写 files 或运行 commands，judge 不能改变 deterministic decision。

Finding title 会为 aggregation 规范化为简洁英文；evidence、recommendations 和 summaries 可以继续使用用户的语言。

Audit trace 写入受信任的 user state root，而不是由 workspace 控制的 path。在受支持的 POSIX runtime 上，Kyoso 会在可用时使用 absolute `$XDG_STATE_HOME`，否则使用 `$HOME/.local/state`；只有 owner、permission、containment 和 symlink 检查均成功时才会写入。验证或 safe open 失败时，它不会静默 fallback 到其他 location：会为该 review fail-close 禁用 Audit 写入，返回 sanitized warning，并继续 review。

Windows，以及无法证明所需 filesystem capability 的环境，会 fail-close 禁用 Audit 写入。能够修改 trusted state root 或 rename 已验证 inode 的 same OS user hostile process 不在此保证范围内；防御该威胁需要 OS sandbox 或 native dirfd-based support。

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

## Agent Models and Effort

省略 `agents.<name>.model` 或 `agents.<name>.effort` 时，会使用各 agent 自身的 default。Codex 使用 local Codex config，例如 `~/.codex/config.toml`；Claude 使用 adapter default。

可指定的 model 名称请参阅 [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview) 与 [Codex models](https://developers.openai.com/codex/models)。

```toml
[agents.codex]
model = "gpt-5.5"
effort = "medium"

[agents.claude]
model = "claude-sonnet-5"
effort = "high"
```

Kyoso 会将 model pins 映射到 adapter-supported configuration：

- Claude: 当 `agents.claude.env` 或 whitelisted parent env 中尚未设置时，设置 `ANTHROPIC_MODEL`。
- Codex: 当 `CODEX_CONFIG` 尚未设置时，设置 `CODEX_CONFIG={"model":"..."}`。若要将 model pin 与其他 Codex session config 组合，请直接设置 `agents.codex.env.CODEX_CONFIG`。

effort 的工作方式不同：Kyoso 不会为它设置 env var，而是在每个 session 中、发送第一个 prompt 之前，向 backend agent 发送一次 ACP `session/set_config_option` 请求(Claude 为 `configId: "effort"`，Codex 为 `configId: "reasoning_effort"`)。有效值取决于 backend agent 的版本和所选的 model(例如，Claude 仅对支持 effort levels 的 model 公开该 option)。Kyoso 本身不会 validate `effort` 的值；如果 backend agent reject 了该请求，或不支持该 option，Kyoso 会将其记录到 stderr 并继续 review。

## Audit

在受支持的 POSIX runtime 上，Audit traces 会写入 user state base（absolute `$XDG_STATE_HOME`，否则 `$HOME/.local/state`）下：

```text
<state-base>/kyoso/workspaces/<sha256(realpath(cwd))>/<logical audit.directory>/<yyyy-mm-dd>/<traceId>.jsonl
```

`audit.directory`是 logical relative directory（默认：`.kyoso/traces`），不是 workspace 内的 directory。现有 workspace `.kyoso/traces`不会被自动迁移或删除。

Raw agent output 和 raw file contents 默认禁用。如果启用 `audit.includeRawAgentOutput`，traces 可能会保留 sensitive review output；请按照 local retention policy 删除旧 traces。在 Windows 或无法证明安全 filesystem capability 的环境中，Audit trace 写入会保持禁用，review 会返回 sanitized warning。

## Config

Kyoso 按以下顺序 load config：

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`，或 `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- `--network` 等 CLI flags，以及 `--set agents.claude.effort=high` 等可重复的 overrides

`plan`、`security` 和 `diff` 接受可重复的 `--set <key>=<value>` overrides。CLI 指定的值优先于 config files，也可以与 `--ignore-config` 一起使用。

- Agent keys: `agents.<codex|claude>.<enabled|model|effort|role|timeoutMs>`
- Verification keys: `verification.<enabled|maxFindings|timeoutMs>`
- Judge keys: `judge.<mode|provider|timeoutMs>`

未知 key 会被拒绝。Boolean / numeric config keys 会转换为 schema 类型，string keys 保持字符串，然后重新验证完整 config。

Project `kyoso.toml` 是 declarative config，不需要 trust approval。它可以设置 tools toggles、agent `enabled` / `model` / `effort` / `role` / `timeoutMs`、workspace byte limits 和 additive `workspace.deny`、verification settings、advisory judge settings，以及 tightening-only security/network settings。

Global TOML 用于 user-owned settings，包括 command 启动和 env forwarding。

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` 已 deprecated，但为了兼容仍然 supported。它只会在 trust-on-first-use approval 之后 load；trusted hashes 保存在 `~/.kyoso/trusted-configs.json`。如果 `kyoso.toml` 和 `kyoso.config.ts` 同时存在，Kyoso 使用 TOML 并忽略 TypeScript config。

Default agent timeouts 是 Codex 120 秒、Claude 300 秒。MCP clients 应允许 tool calls 至少运行 360 秒。如果 `verification.enabled` 为 true，Kyoso 可能会运行额外的 cross-agent verification round，因此建议至少允许 480 秒。

Optional finding verification 默认 disabled:

```toml
[verification]
enabled = false
maxFindings = 5
timeoutMs = 90000
# global config only; project kyoso.toml cannot set this
allowDemotion = false
```

启用后，Kyoso 会让没有报告该 finding 的 agent 对 high/critical 且 single-source 的 finding 尝试反驳。Phase 1 是 annotate-only：verification 可以更新 finding confidence 和 notes，但不会改变 severity 或 final decision。`allowDemotion` 为未来的 opt-in phase 保留，目前是 no-op。

Judge LLMs 是 optional。设置 `OPENAI_API_KEY` 或 `CODEX_API_KEY` 可使用 OpenAI judge，设置 `ANTHROPIC_API_KEY` 可使用 Anthropic judge。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults 有意使用 lightweight models。若需要更强的 judge，请将 `KYOSO_ANTHROPIC_JUDGE_MODEL` 设置为 Sonnet-class model，例如 `claude-sonnet-5`。

Subscription-only setup:

- Codex: 使用 local `codex` login
- Claude: 运行 `claude setup-token`，然后设置 `CLAUDE_CODE_OAUTH_TOKEN`
- Judge: 不设置 API keys，因此 Kyoso 使用 `deterministic_fallback`
- 当存在 `OPENAI_API_KEY` 时，如需避免 OpenAI judge calls，请设置 `judge.provider = "none"`

Team admins 还应检查 organization Usage credits。如果启用了 credits，超出 subscription limits 的 billing behavior 由 Kyoso 外部控制。

## Troubleshooting

- MCP timeout: 将 client tool timeouts 设置为至少 360 秒；当 `verification.enabled` 为 true 时，设置为至少 480 秒。Kyoso defaults 是 Codex 120 秒、Claude 300 秒、verification 90 秒。
- Fresh npm release: safe-chain 等 minimum-package-age protection 可能会在 publish 后短时间内 block `npx @kyo-so/cli` resolution。
- Deprecated TypeScript config: 除非传入 `--trust-config`，否则 untrusted `kyoso.config.ts` 会被 skip；新配置请使用 `kyoso.toml`。

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents；不要在 production 中设置。
- `KYOSO_KEEP_TEMP=1`: 为 local debugging 保留 temporary snapshots。

## License

Kyoso 使用 GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) 授权。

Kyoso 设计为作为 separate CLI 或 MCP server process 使用。将 Kyoso embedding、importing 或 linking 到另一个 program 中，可能会产生不同的 license implications。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
