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

当只启用一个 backend 时，会由 1 个 agent 以 `combined_reviewer` 运行，替代双角色 ensemble（参见 [Single-backend mode](#single-backend-mode)）。此图的 Mermaid 源文件位于 [docs/assets/](docs/assets/)。

## Quick Start

无需全局安装。通过 `npx` 或 `bunx` 运行 Kyoso。运行打包后的 CLI 需要 Node.js 20 或更高版本。

### 集成模式

| 模式               | 安装内容             | MCP | 客户端             |
| ------------------ | -------------------- | --: | ------------------ |
| Marketplace Plugin | Skill＋本地stdio MCP |  有 | Codex／Claude Code |
| CLI＋Skill-only    | npm CLI＋Skill       |  无 | Codex／Claude Code |
| 手动setup          | 手动MCP注册＋Skill   |  有 | Codex／Claude Code |

拿不准时请选择Marketplace Plugin：两条命令即可同时安装Skill和MCP server。步骤见下方的[Codex](#codex)／[Claude Code](#claude-code)小节。之后如需切换集成模式，请参阅[迁移](#迁移)。

#### Marketplace Plugin

Plugin包含Skill和pin到已发布Kyoso CLI精确版本的MCP定义，但不包含CLI本体。MCP首次启动需要访问npm网络。已缓存的package可能可以offline启动，但不作保证。manifest中的`Read` capability仅是显示metadata，不会授予额外filesystem权限。

`kyoso setup ... --with-openrouter` 的输出和手动 setup 示例仍是用户管理的客户端注册模板。Marketplace Plugin `0.4.0` pin 到 `@kyo-so/cli@0.10.0`。

Plugin中的Skill将内置的`kyoso` MCP server声明为dependency，因此显式Kyoso review会通过MCP而不是CLI fallback。如果禁用内置Plugin MCP，应将Plugin Skill视为不可用：重新启用MCP，或移除Plugin并改用CLI＋Skill-only。Plugin不是CLI fallback mode。

Marketplace Plugin `0.4.0` 向 MCP process 暴露 `OPENROUTER_API_KEY` 变量名，但不保存 credential 值。Kyoso 仅将该值传给显式选择 OpenRouter 的 Codex child，并将未展开的 placeholder 视为未设置。

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

在Codex Auto mode中，需要approval的Kyoso tool调用可能会被拒绝。若要仅为个人账户预先批准，请参阅 [Codex approval prompts](#codex-approval-prompts)。

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

## CLI

`npx @kyo-so/cli` 和 `bunx @kyo-so/cli` 是正常执行路径。下面的示例将此前缀简写为 `kyoso`。Naming note: npm package 是 `@kyo-so/cli` (对应产品名 Kyo-so)，安装后的 CLI command 是更短的 `kyoso`。

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

## Configuration

### Files and precedence

Kyoso 按以下顺序 load config：

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`，或 `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- `--network` 等 CLI flags，以及 `--set agents.claude.effort=high` 等可重复的 overrides

`plan`、`security` 和 `diff` 接受可重复的 `--set <key>=<value>` overrides。CLI 指定的值优先于 config files，也可以与 `--ignore-config` 一起使用。

未知 key 会被拒绝。Boolean / numeric config keys 会转换为 schema 类型，string keys 保持字符串，然后重新验证完整 config。

Project `kyoso.toml` 是 declarative config，不需要 trust approval。它可以设置 tools toggles、agent `enabled` / `model` / `effort` / `role` / `timeoutMs`、经过 user global authorization 的 Codex `provider` 或继承 OpenRouter 时的 model 覆盖、workspace byte limits 和 additive `workspace.deny`、verification settings、advisory judge settings，以及 tightening-only security/network settings。

Global TOML 用于 user-owned settings，包括 command 启动和 env forwarding。

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]
# 仅授权此精确 project directory 选择 `provider`，或在继承 OpenRouter 时
# 覆盖 model。
allowProjectProvider = ["/absolute/path/to/project"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` 已 deprecated，但为了兼容仍然 supported。它只会在 trust-on-first-use approval 之后 load；trusted hashes 保存在 `~/.kyoso/trusted-configs.json`。如果 `kyoso.toml` 和 `kyoso.config.ts` 同时存在，Kyoso 使用 TOML 并忽略 TypeScript config。

### Agents

Agent keys: `agents.<codex|claude>.<enabled|model|effort|role|timeoutMs>`。Codex 还支持 `agents.codex.provider`：`"openrouter"` 选择 external provider，而 `"default"` 会将继承的 OpenRouter 选择重置为正常 Codex behavior；Claude 没有 provider 设置。`agents.codex.allowProjectProvider` 只能在 global config 中设置，它是 absolute project directory allowlist：只有完全匹配的 project TOML 能选择 `provider`，或在继承 OpenRouter 时覆盖 `model`；不匹配子目录或 glob。不能通过 project config 或 `--set` 修改，legacy boolean 值会被拒绝。`command` / `args` / `env` 也只能在 global config 中设置（参见 [Files and precedence](#files-and-precedence)）。

省略 `agents.<name>.model` 或 `agents.<name>.effort` 时，会使用各 agent 自身的 default。Codex 使用 local Codex config，例如 `~/.codex/config.toml`（若已设置`CODEX_HOME`，则为`$CODEX_HOME/config.toml`）；Claude 使用 adapter default。

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

### Codex OpenRouter project opt-in

先在 user global config 中授权 project-level OpenRouter routing：

```toml
# ~/.config/kyoso/config.toml
[agents.codex]
allowProjectProvider = ["/absolute/path/to/project"]
```

再只在需要 OpenRouter 的 project 中 opt in：

```toml
# <project>/kyoso.toml
[agents.codex]
provider = "openrouter"
model = "openai/o4-mini"
```

当 `provider = "openrouter"` 时，`model` 必须存在且不能是空白。它是 OpenRouter model ID；Kyoso 不会 validate model catalog 或该 model 是否支持 tool calling，请向 provider 确认 tool support。

`allowProjectProvider` 适用于 project `provider`，以及继承 OpenRouter 时 project 对 `model` 的覆盖；list 必须完全匹配包含已解析 project config file 的 canonical directory 的 absolute path，而不是 invocation cwd 或 lexical path。project config file（包括受信任的 `kyoso.config.ts`）与 allowlist entry 都会通过 symlink 解析到该 directory；解析到同一 directory 的 entry 会匹配，解析到其他位置或无法解析的 path 会 fail closed。user-global `provider = "openrouter"` 不需要 allowlist entry。直接选择 CLI 时，必须在同一 invocation 中同时使用 `--set agents.codex.provider=openrouter` 和 `--set agents.codex.model=<model>`；project model 不能为该 CLI provider override 补足 model。`allowProjectProvider` 不是 `--set` path，legacy boolean 值会被拒绝。

当 user-global config 选择 OpenRouter 时，project 可以用 `provider = "default"` 显式 opt-out。这个 reset 不需要 model 或 authorization；除非同一 layer 明确提供普通 Codex model，它还会清除继承的 OpenRouter model，并且不会为该 project forward OpenRouter key。

在启动 Kyoso 的 Codex 或 Claude client process 的 environment 中设置 key。直接设置 environment variable 是 primary path；1Password 等 secret manager 是 optional，不是 Kyoso dependency。

```bash
export OPENROUTER_API_KEY="<secret>"
```

key 不会存入 `kyoso.toml`、Git 管理的 config、Audit trace 或 review output。无论它来自 Kyoso process 还是显式 `agents.codex.env`，只有选中该 provider 时，Kyoso 才会将它 forward 给 Codex child。当省略 `provider` 或设为 `provider = "default"` 时，Kyoso 会有意阻止这两种来源；非空的显式 `agents.codex.env.OPENROUTER_API_KEY` 还会产生说明其未被 forward 的 sanitized warning。由于只有被选中的 Codex OpenRouter child 能接收 key，另一个 child configuration（例如 `agents.claude.env`）中的非空 key 也会产生相同 warning。省略 `provider` 会保留现有 Codex login、`OPENAI_API_KEY`、`CODEX_API_KEY` 和 `CODEX_CONFIG` 行为；删除该行即可回到这些行为。

GUI client 可能不会继承 shell export。使用 `kyoso setup <client> --write --with-openrouter` 创建新的 manual MCP registration，重启 client 后再运行 `kyoso doctor` 检查 Kyoso process 能否检测到 key。`kyoso setup` 会保留已有 MCP entry 而不会重写，因此已有 registration 需要根据[示例](examples/codex-config.toml)手动更新 opt-in allowlist。

新的 manual MCP registration 默认不包含 `OPENROUTER_API_KEY`。仅在有意选择 provider 后使用 `--with-openrouter` 添加它；已有 registration 永不重写。Claude Code registration 中的 `${OPENROUTER_API_KEY}` 必须由 client 展开；Kyoso 只会忽略完全由 `${NAME}`、`$NAME` 或 `%NAME%`（允许前后空白）构成的未展开 credential placeholder，并且只输出含变量名的 sanitized warning。含有其他文字的值会被保留。对于以 `_KEY`、`_TOKEN`、`_SECRET` 或 `_PASSWORD` 结尾的 custom credential-like name，也适用同一规则；非 credential template 会被保留。

推荐使用这种经过 user authorization 的 project-scoped opt-in。global `provider = "openrouter"` 会被 project 继承，直到 project 设置 `provider = "default"`；仅省略 `provider` 不会将其 unset。固定的 OpenRouter Responses API preset 为 beta；不开放 custom endpoint、provider routing、fallback 或 judge integration。为将 key 绑定到该 preset，OpenRouter mode 会拒绝含 top-level `profile` 或 `profiles` 的 `CODEX_CONFIG`，并会在启动 child 前拒绝非 object 的 `model_providers` value。对于 object，它会将 `model_providers` 替换为仅含固定 `kyoso-openrouter` entry 的对象，并发出只包含已丢弃 entry 数量的 sanitized warning；不会显示 provider ID 或 config value。除这些被拒绝的 field 外，它会保留 `model`、`model_provider` 和 `model_providers` 之外无关的 `CODEX_CONFIG` field，因此 foreign provider configuration 无法选择使用该 key 的 endpoint。Claude 仍使用已配置的 provider，judge 不会使用 `OPENROUTER_API_KEY`。

经过 user-global authorization 后，project `kyoso.toml` 可以选择 external provider，或覆盖继承的 OpenRouter model，并将 review context 路由给它。对于 untrusted repository，请使用 `--ignore-config`，并只显式传入所需的 CLI options。

真实的 Codex ACP/OpenRouter smoke 是 release-gated，不会在测试中运行。只有在明确批准 network 和 billing 后，才在 client environment 中 export key 并运行：

```bash
KYOSO_OPENROUTER_ACP_SMOKE=release KYOSO_OPENROUTER_MODEL=<model> safe-chain bun run smoke:openrouter:codex-acp
```

该 command 不接受 CLI arguments，使用固定版本的 Codex ACP adapter，并创建全新的空 temporary workspace、`HOME` 和 `CODEX_HOME`，不会使用调用方 repository 或 cached Codex login。它只返回固定的成功或失败消息，不会将 key 或 model 写入 config、temporary artifact 或 output。

### Agent auth

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

`OPENROUTER_API_KEY` 被有意排除在常规 Codex allowlist 之外。只有 `agents.codex.provider = "openrouter"` 时才从 Kyoso process copy；key 缺失或为空时不会启动 Codex child，而是返回结构化的 agent failure，其他 reviewer 可以在 degraded mode 下继续。

为最小化凭据暴露，OpenRouter 模式还会从 Codex child 中移除 `OPENAI_API_KEY`、`CODEX_API_KEY` 和 `CODEX_ACCESS_TOKEN`；`CODEX_HOME` 会保留给本地 adapter state。因此 adapter 仍可读取 local login cache，这属于 defense in depth 而非 credential isolation。

Kyoso 还会 forward 启动 subprocesses 所需的最小 runtime env：`PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `USERNAME`, `SystemRoot`。

Subscription-only setup:

- Codex: 使用 local `codex` login
- Claude: 运行 `claude setup-token`，然后设置 `CLAUDE_CODE_OAUTH_TOKEN`
- Judge: 默认的 `deterministic_only` mode 不需要 API key（参见 [Judge](#judge)）
- 如需禁用显式 LLM judge opt-in，请设置 `judge.mode = "deterministic_only"` 或 `judge.provider = "none"`

Team admins 还应检查 organization Usage credits。如果启用了 credits，超出 subscription limits 的 billing behavior 由 Kyoso 外部控制。

### Single-backend mode

Kyoso 可以在只有 Claude 或只有 Codex 可用时运行。请在 `kyoso.toml` 中禁用缺失的 backend；示例见 `examples/claude-only.toml` 和 `examples/codex-only.toml`。

在 single-agent mode 中，剩余 backend 会以 `combined_reviewer` 运行一次，同时覆盖 implementation 和 architecture/security 两类关注点。JSON output 会包含 `reviewMode: "single_agent"` 和 `agentsUsed`；Markdown output 会说明未执行 cross-model verification，并将 disagreements 标记为 N/A。

该 mode 不提供独立的 cross-model validation，仍可能有 self-review bias。它仍保留独立只读 review process、temporary snapshots、adversarial review prompts、secret scanning 和 deterministic gates。

### Execution budget and review stopping

每次 review 都有 user-global hard ceiling，用于限制 model call 数、总 wall time、streaming agent text（message 和 thought chunk）以及每个 agent 的 finding 数量。

```toml
[reviewBudget]
maxModelCalls = 4
maxTotalWallTimeMs = 480000
maxAgentOutputBytes = 65536
maxFindingsPerAgent = 10
skipOptionalPhasesWhenTokenUsageUnknown = true
```

`reviewBudget` 只能在 user-global 配置中设置；project `kyoso.toml` 和 `--set` 都不能修改它。MCP / library request 只能通过 `options.reviewBudget` 降低 ceiling，不能提高。Kyoso 会先同时预留两个 primary reviewer，再将剩余 call 用于 verification，并把 LLM Judge 作为 advisory。默认 Judge mode 是 `deterministic_only`。

结果包含 `completion`、`executionBudget` 和 `requestFingerprint`。Markdown 与 Audit 会显示 call 数、wall time、output bytes，以及 reported 或 unknown token usage。若 `completion.status` 为 `incomplete`，Kyoso 返回普通的 `block` 结果且 `retryable: false`：该 block 表示 review coverage 未完成，而不是已经确认 code defect。不要自动重试相同 fingerprint。对于一个 review checkpoint，bundled Skill 只允许首次评审与 material fix 后的确认评审各1次；第三次需要用户明确批准。

### Verification

Verification keys: `verification.<enabled|maxFindings|timeoutMs>`。Optional finding verification 默认 disabled:

```toml
[verification]
enabled = false
maxFindings = 5
timeoutMs = 90000
# global config only; project kyoso.toml cannot set this
allowDemotion = false
```

启用后，Kyoso 会让没有报告该 finding 的 agent 对 high/critical 且 single-source 的 finding 尝试反驳。Phase 1 是 annotate-only：verification 可以更新 finding confidence 和 notes，但不会改变 severity。若 verification 被 skip、失败、预算耗尽或 overflow，finding 会保留为 `not_verified`，并返回 incomplete coverage。`allowDemotion` 为未来的 opt-in phase 保留，目前是 no-op。

### Judge

Judge keys: `judge.<mode|provider|timeoutMs>`。Judge LLMs 是 optional，默认 `mode = "deterministic_only"`；仅设置 credential 不会启动 judge call。OpenAI judge 需要 `mode = "deterministic_plus_llm"` 与 `OPENAI_API_KEY` 或 `CODEX_API_KEY`；Anthropic judge 需要同一 mode 与 `ANTHROPIC_API_KEY`。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults 有意使用 lightweight models。若需要更强的 judge，请将 `KYOSO_ANTHROPIC_JUDGE_MODEL` 设置为 Sonnet-class model，例如 `claude-sonnet-5`。

### Timeouts

Default agent timeouts 是 Codex 120 秒、Claude 300 秒；verification round 默认 90 秒。review-wide deadline 默认480秒，各 phase 使用剩余 deadline 而不会延长它。MCP clients 应允许 tool calls 至少运行480秒。

### Audit

在受支持的 POSIX runtime 上，Audit traces 会写入 user state base（absolute `$XDG_STATE_HOME`，否则 `$HOME/.local/state`）下：

```text
<state-base>/kyoso/workspaces/<sha256(realpath(cwd))>/<logical audit.directory>/<yyyy-mm-dd>/<traceId>.jsonl
```

`audit.directory`是 logical relative directory（默认：`.kyoso/traces`），不是 workspace 内的 directory。现有 workspace `.kyoso/traces`不会被自动迁移或删除。

Raw agent output 和 raw file contents 默认禁用。如果启用 `audit.includeRawAgentOutput`，traces 可能会保留 sensitive review output；请按照 local retention policy 删除旧 traces。在 Windows 或无法证明安全 filesystem capability 的环境中，Audit trace 写入会保持禁用，review 会返回 sanitized warning（参见 [Safety Model](#safety-model)）。

## Safety Model

Kyoso MVP 使用 disposable temporary snapshot 和 policy-level write denial。它不是完整的 OS sandbox。除非你理解相关风险，否则不要针对 untrusted repositories 运行 Kyoso。

Secret detection 是 best-effort。如果 Kyoso 在 request、selected files 或 diff 中检测到疑似 secret，它会 redact 该值，并默认在 backend agents 运行前 block。

Kyoso 不存储 provider credentials。Child agent environment variables 使用 allowlist。

Repository content、plans、diffs 和 selected files 在 backend prompts 中被视为 untrusted data。Kyoso 会用 `<untrusted-content>` tags 包裹它们，并告诉 agents 不要遵循其中的 instructions。最终 decisions 来自 schema-constrained findings；agents 不能写 files 或运行 commands，judge 不能改变 deterministic decision。

Finding title 会为 aggregation 规范化为简洁英文；evidence、recommendations 和 summaries 可以继续使用用户的语言。

Audit trace 写入受信任的 user state root，而不是由 workspace 控制的 path。在受支持的 POSIX runtime 上，Kyoso 会在可用时使用 absolute `$XDG_STATE_HOME`，否则使用 `$HOME/.local/state`；只有 owner、permission、containment 和 symlink 检查均成功时才会写入。验证或 safe open 失败时，它不会静默 fallback 到其他 location：会为该 review fail-close 禁用 Audit 写入，返回 sanitized warning，并继续 review。

Windows，以及无法证明所需 filesystem capability 的环境，会 fail-close 禁用 Audit 写入。能够修改 trusted state root 或 rename 已验证 inode 的 same OS user hostile process 不在此保证范围内；防御该威胁需要 OS sandbox 或 native dirfd-based support。

## 迁移

- 从手动MCP迁移到CLI＋Skill：先安装CLI和Skill，再运行`codex mcp remove kyoso`或`claude mcp remove kyoso --scope local|project|user`。
- 从CLI＋Skill迁移到Plugin：添加Plugin并确认enabled后，再删除手动MCP注册。手动复制的Skill不会自动删除。
- 从Plugin迁移到CLI＋Skill：先安装CLI和Skill，再运行`codex plugin remove kyoso@kyoso`。
- 从CLI＋Skill恢复到手动MCP：运行`kyoso setup codex --write`或`kyoso setup claude-code --write`。

## Troubleshooting

- MCP timeout: 将 client tool timeouts 设置为至少 360 秒；当 `verification.enabled` 为 true 时，设置为至少 480 秒。Kyoso defaults 请参阅 [Timeouts](#timeouts)。
- Fresh npm release: safe-chain 等 minimum-package-age protection 可能会在 publish 后短时间内 block `npx @kyo-so/cli` resolution。
- Deprecated TypeScript config: 除非传入 `--trust-config`，否则 untrusted `kyoso.config.ts` 会被 skip；新配置请使用 `kyoso.toml`。
- OpenRouter key missing: 确认 Codex `model` 非空、`OPENROUTER_API_KEY` 已 forward 给 Kyoso process，并已重启 client；再运行 `kyoso doctor`。Marketplace Plugin `0.4.0` 及更高版本会将此变量名 forward 给 Kyoso process，旧版本不会。setup 也不会重写已有 MCP registration。

### Codex approval prompts

在Codex Auto mode中，需要approval的Kyoso tool调用可能会被拒绝。若要仅为个人账户预先批准，请将以下设置添加到`~/.codex/config.toml`（若已设置`CODEX_HOME`，则为`$CODEX_HOME/config.toml`）。**只有在你信任Kyoso，并接受所选代码与review context可能发送给已配置的外部model provider时，才应启用此设置。** Plugin默认不会启用它。

```toml
[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.diff_review]
approval_mode = "approve"

[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.plan_review]
approval_mode = "approve"

[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.security_review]
approval_mode = "approve"
```

如果Kyoso不是通过Plugin、而是直接注册为MCP server（`kyoso setup codex --write` 或手动设置），请使用不带 `plugins."kyoso@kyoso".` 前缀的 `mcp_servers.kyoso` 键：

```toml
[mcp_servers.kyoso.tools.diff_review]
approval_mode = "approve"

[mcp_servers.kyoso.tools.plan_review]
approval_mode = "approve"

[mcp_servers.kyoso.tools.security_review]
approval_mode = "approve"
```

## Development

本地开发：

```bash
nix develop
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
safe-chain bun run pack:verify
```

Nix dev shell 会 pin Node.js 24 和 nixpkgs 提供的 Bun version。确认 `.envrc` 后，也可以运行一次 `direnv allow`，让它自动加载 shell。CI 仍然 pin 到 Bun 1.3.14；当前 nixpkgs Bun version 可能略有不同，但 `flake.lock` 会保证 local shell 可复现。

test suite 包含 credential-free 的 MCP stdio 和 ACP subprocess integration coverage。`pack:verify` 还会启动打包后的 `dist/bin/kyoso.js` MCP server，并检查已发布 bundle 的 protocol handshake。

已知分发风险：`@modelcontextprotocol/server` 目前还没有 stable release；Kyoso 当前 pin 了 prerelease API，因此 MCP SDK API 变更可能需要后续 release。在 bump `@modelcontextprotocol/server`、`@agentclientprotocol/sdk` 或 pin 的 ACP adapters 的 release 之前，请先手动运行 real-agent dogfooding。

用于 debug 的 environment variables：

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents；不要在 production 中设置。
- `KYOSO_KEEP_TEMP=1`: 为 local debugging 保留 temporary snapshots。

## License

Kyoso 使用 GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) 授权。

Kyoso 设计为作为 separate CLI 或 MCP server process 使用。将 Kyoso embedding、importing 或 linking 到另一个 program 中，可能会产生不同的 license implications。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
