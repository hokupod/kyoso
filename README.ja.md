# Kyo-so

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hokupod/kyoso)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

この翻訳は英語版より古い場合があります。最新の情報は英語版 README を参照してください。

Kyo-so (Kyoso / 協奏) は、AI coding workflow 向けの MCP-native、ACP-powered な multi-agent review gate です。

「協奏」という名前には、複数の独立した奏者がそれぞれの役割を保ちながら、ひとつの成果をつくるという意味を込めています。

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-ensemble.png" alt="指揮者がドラマー・バイオリニスト・ピアニストをまとめる様子" width="480">
</p>

Kyo-so は Codex と Claude の reviewer を連携させ、次のレビューを行います。

- implementation plan review
- CISA Secure by Design gate による security review
- 実装後の diff review

Kyoso はコード変更を適用しません。

## Review Flow

3 つの review tool はすべて同じパイプラインで動きます。secret scan の後、read-only の一時スナップショット上で reviewer ensemble を ACP 経由で並列実行し、所見の集約・ゲート適用・決定を行います。

<p align="center">
  <img src="https://raw.githubusercontent.com/hokupod/kyoso/main/docs/assets/kyoso-review-flow.ja.svg" alt="Kyo-so のレビュー実行フロー。MCP/CLI リクエストから secret scan、スナップショット、アンサンブルレビュー、集約、ゲート、最終決定まで" width="640">
</p>

backend が 1 つだけ有効な場合は、2 role の ensemble の代わりに 1 agent が `combined_reviewer` として実行されます。この図の Mermaid ソースは [docs/assets/](docs/assets/) にあります。

## Quick Start

グローバルインストールは不要です。Kyoso は `npx` または `bunx` で実行します。

### 導入モード

| モード             | 導入物                   |  MCP | 対象               |
| ------------------ | ------------------------ | ---: | ------------------ |
| Marketplace Plugin | Skill＋ローカルstdio MCP | あり | Codex              |
| CLI＋Skill-only    | npm CLI＋Skill           | なし | Codex／Claude Code |
| 手動setup          | 手動MCP登録＋Skill       | あり | Codex／Claude Code |

#### Codex Marketplace Plugin

```bash
codex plugin marketplace add hokupod/kyoso
codex plugin list --marketplace kyoso --available --json
codex plugin add kyoso@kyoso
codex plugin list --marketplace kyoso --json
```

Codex desktopのPlugins pageまたは`/plugins`からKyosoを選ぶこともできます。追加したMarketplaceが見えない場合はdesktop appをrefresh／restartしてください。削除は`codex plugin remove kyoso@kyoso`です。

PluginはSkillと`@kyo-so/cli@0.8.0`へpinしたMCP定義を同梱しますが、CLI本体は同梱しません。MCPの初回起動ではnpmへのnetwork accessが必要です。cache済みpackageでoffline起動できる場合はありますが、保証しません。manifestの`Read` capabilityは表示metadataであり、filesystem認可を追加するものではありません。

#### CLI＋Skill-only

```bash
# Global CLI＋Codex Skill
npm install -g @kyo-so/cli
kyoso setup codex --write --skill-only --global

# Project CLI＋Codex Skill
npm install -D @kyo-so/cli
npx kyoso setup codex --write --skill-only
```

Claude Codeでは`codex`を`claude-code`へ置き換えます。既定はdry-runです。`--skill-only`はMCP設定を読み書きせず、`--runner`／`--command`とは併用できません。

#### 移行

- 手動MCPからCLI＋Skill: CLIとSkillを先に導入し、`codex mcp remove kyoso`または`claude mcp remove kyoso --scope local|project|user`を実行します。
- CLI＋SkillからPlugin: Pluginを追加してenabledを確認してから、手動MCP登録を削除します。手動コピーSkillは自動削除しません。
- PluginからCLI＋Skill: CLIとSkillを先に導入し、`codex plugin remove kyoso@kyoso`を実行します。
- CLI＋Skillから手動MCPへ戻す: `kyoso setup codex --write`または`kyoso setup claude-code --write`を実行します。

### Claude Only / Codex Only

Kyoso は Claude だけ、または Codex だけでも実行できます。利用できない backend は `kyoso.toml` で無効化してください。例は `examples/claude-only.toml` と `examples/codex-only.toml` にあります。

single-agent mode では、残った backend が `combined_reviewer` として 1 回だけ実行され、implementation と architecture/security の両方を確認します。JSON output には `reviewMode: "single_agent"` と `agentsUsed` が入り、Markdown output には cross-model verification が行われていないことと disagreements が N/A であることを表示します。

この mode では独立した cross-model validation はなく、自己レビュー bias が残ります。一方で、別プロセスの read-only review、temporary snapshots、adversarial review prompts、secret scanning、deterministic gates は利用できます。

### Claude Code

1. Claude 認証を準備します。

```bash
claude setup-token
```

このコマンドで得た `CLAUDE_CODE_OAUTH_TOKEN` を設定するか、直接 API 課金を使う場合は `ANTHROPIC_API_KEY` を設定します。

2. MCP を登録し、review skill をインストールします。

```bash
npx @kyo-so/cli setup claude-code --write
bunx @kyo-so/cli setup claude-code --write
```

3. セットアップを確認します。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. Claude Code からレビューを依頼します。

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. Codex 認証を準備します。

```bash
codex login
```

2. MCP を登録し、review skill をインストールします。

```bash
npx @kyo-so/cli setup codex --write
bunx @kyo-so/cli setup codex --write
```

3. セットアップを確認します。

```bash
npx @kyo-so/cli doctor
bunx @kyo-so/cli doctor
```

4. Codex からレビューを依頼します。

```text
Use Kyoso diff_review on the current diff. I need a second opinion before merging.
```

手動セットアップ用の例は `examples/codex-config.toml` と `examples/claude-code-mcp.json` にあります。

## Install / Run

```bash
npx @kyo-so/cli mcp
bunx @kyo-so/cli mcp
```

Naming note: npm パッケージは `@kyo-so/cli` (製品名 Kyo-so に対応) で、インストールされる CLI コマンドは短い `kyoso` です。

ローカル開発:

```bash
nix develop
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

パッケージ化された CLI を実行するには Node.js 20 以降が必要です。

Nix dev shell は Node.js 24 と nixpkgs が提供する Bun version を固定します。`.envrc` を確認してから `direnv allow` を一度実行すると、自動で shell を読み込めます。CI は Bun 1.3.14 に pin したままです。現在の nixpkgs Bun version は少し異なる場合がありますが、`flake.lock` により local shell の再現性を保ちます。

既知の配布リスク: `@modelcontextprotocol/server` にはまだ stable release がありません。Kyoso は現在 prerelease API を pin しているため、MCP SDK API の変更に追従する follow-up release が必要になる場合があります。

## CLI

通常の実行経路は `npx @kyo-so/cli` と `bunx @kyo-so/cli` です。以下の例では、この prefix を `kyoso` と省略しています。

```bash
kyoso plan --goal "Review this OAuth callback plan" --plan plan.md
kyoso security --goal "Review this auth diff" --diff changes.patch
kyoso diff --base main --head HEAD --set agents.claude.effort=high
kyoso doctor
kyoso init
kyoso setup codex
kyoso setup claude-code
kyoso setup codex --skill-only
kyoso setup claude-code --skill-only
```

## Usage Examples

選択したコードと一緒に implementation plan をレビューします。

```bash
kyoso plan \
  --goal "Review the OAuth callback implementation plan" \
  --plan plan.md \
  --file src/auth/callback.ts
```

結果は上から順に読んでください。`Decision` は deterministic gate の結果、`Findings` は必要な変更、`Tests to Add` は承認前に Kyoso が期待する regression checks です。

patch に対して CISA Secure by Design security review を実行します。

```bash
kyoso security \
  --goal "Review auth changes for tenant isolation and secure defaults" \
  --diff changes.patch \
  --json
```

JSON output では、`cisaSecureByDesign` に 4 つの gate dimensions が表示されます。customer security outcomes の `fail` は review を block します。warning-level dimensions は通常 `approve_with_changes` になります。

Kyoso を Codex または Claude Code の MCP server として登録し、client から `plan_review` を呼び出します。

```toml
# See examples/codex-config.toml
[mcp_servers.kyoso]
command = "npx"
args = ["-y", "@kyo-so/cli", "mcp", "--network", "model_only"]
```

client request の例:

```text
Use Kyoso plan_review on this plan and the selected auth files. I need a second opinion before implementing.
```

## MCP

```bash
npx @kyo-so/cli mcp --network model_only
bunx @kyo-so/cli mcp --network model_only
```

`--network` を省略すると、Kyoso は `model_only` を使用します。これは Kyoso が backend agents からの通信を model-provider traffic のみにすることを期待する policy-level constraint です。OS-level network isolation ではありません。

Kyoso が公開する MCP tools は次の 3 つだけです。

- `plan_review`
- `security_review`
- `diff_review`

MCP stdout は protocol messages 専用です。logs は stderr または local audit traces に出力されます。

## Skill

同梱の `kyoso-review` skill は意図的に狭い用途にしています。Kyoso、multi-agent review、plan review、security review、CISA Secure by Design review、diff review を明示的に依頼したときだけ trigger されるべきです。

Skillは利用可能な最初の経路を使います。順序はKyoso MCP tools、PATH上のインストール済み`kyoso`、`npx -y @kyo-so/cli`、`bunx @kyo-so/cli`です。package runner fallbackはnetwork accessが必要になり、version driftも起こり得るため、MCPなしの通常経路にはインストール済みCLIを使います。

`kyoso setup codex --write --skill-only`はcanonical Skill directoryを既定で`.agents/skills/kyoso-review/`へコピーします。`--global`を追加すると`~/.agents/skills/kyoso-review/`へコピーします。

`kyoso setup claude-code --write --skill-only`は既定で`.claude/skills/kyoso-review/`へコピーします。`--global`を追加すると`~/.claude/skills/kyoso-review/`へコピーします。

managed installはcanonical directoryのdigestとCLI versionを`.kyoso-install.json`へ記録します。現行または既知historical copyはadoptして自動更新します。変更済み／未知のcopyはconflictとして残し、上書きしません。`--force`はそのSkill directoryだけを置換し、MCP設定を削除・上書きしません。

## Safety Model

Kyoso MVP は disposable temporary snapshot と policy-level write denial を使用します。完全な OS sandbox ではありません。リスクを理解していない場合、untrusted repositories に対して Kyoso を実行しないでください。

Secret detection は best-effort です。Kyoso は request、selected files、diff 内で secret らしき値を検出すると、その値を redact し、既定では backend agents の実行前に block します。

Kyoso は provider credentials を保存しません。Child agent environment variables は allowlist されます。

Repository content、plans、diffs、selected files は backend prompts 内で untrusted data として扱われます。Kyoso はそれらを `<untrusted-content>` tags で包み、その中にある instructions に従わないよう agents に指示します。最終判断は schema-constrained findings から導出されます。agents は files の書き込みや commands の実行ができず、judge は deterministic decision を変更できません。

Finding title は aggregation のため簡潔な英語に正規化されます。evidence、recommendations、summaries はユーザーの言語のままで構いません。

## Agent Auth

Codex は利用可能な場合、local `codex` login を使用します。既定の subscription-backed path では API key は不要です。

Claude は 2 つの auth paths をサポートします。

- `ANTHROPIC_API_KEY`: direct Anthropic API billing
- `CLAUDE_CODE_OAUTH_TOKEN`: `claude setup-token` から得る subscription auth

Claude credentials が両方設定されている場合、Kyoso は既定で `CLAUDE_CODE_OAUTH_TOKEN` だけを Claude child agent に forward します。`ANTHROPIC_API_KEY` だけを forward するには、`agents.claude.auth.preferApiKey: true` を設定してください。

Default child-agent env allowlist:

| Agent  | Provider env                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex  | `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_ACCESS_TOKEN`                                                                                                                        |
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` |

Kyoso は subprocesses の起動に必要な最小限の runtime env も forward します: `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `USERNAME`, `SystemRoot`。

## Agent Models and Effort

`agents.<name>.model` または `agents.<name>.effort` を省略すると、各 agent 独自の default を使用します。Codex は `~/.codex/config.toml` などの local Codex config を使用し、Claude は adapter default を使用します。

指定できる model 名は [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview) と [Codex models](https://developers.openai.com/codex/models) を参照してください。

```toml
[agents.codex]
model = "gpt-5.5"
effort = "medium"

[agents.claude]
model = "claude-sonnet-5"
effort = "high"
```

Kyoso は model pins を adapter-supported configuration に mapping します。

- Claude: `agents.claude.env` または whitelisted parent env で未設定の場合に `ANTHROPIC_MODEL` を設定します。
- Codex: `CODEX_CONFIG` が未設定の場合、`CODEX_CONFIG={"model":"..."}` を設定します。model pin と他の Codex session config を組み合わせるには、`agents.codex.env.CODEX_CONFIG` を直接設定してください。

effort は仕組みが異なります。Kyoso は env var を設定せず、session ごとに最初の prompt の前に一度、backend agent へ ACP の `session/set_config_option` リクエストを送信します(Claude は `configId: "effort"`、Codex は `configId: "reasoning_effort"`)。有効な値は backend agent のバージョンと選択した model に依存します(例えば Claude は effort levels に対応した model でのみこの option を公開します)。Kyoso は `effort` の値自体を validate しません。backend agent がリクエストを reject した場合、または対応していない場合、Kyoso は stderr に log を出力してレビューを継続します。

## Audit

Audit traces は次の場所に書き込まれます。

```text
.kyoso/traces/<yyyy-mm-dd>/<traceId>.jsonl
```

Raw agent output と raw file contents は既定で無効です。

`.kyoso/traces/` を Git に含めないでください。`kyoso init` は `.kyoso/` を `.gitignore` に追加し、この repository も同じ設定にしています。`audit.includeRawAgentOutput` を有効にすると、traces に sensitive review output が残る場合があります。local retention policy に従って古い traces を定期的に削除してください。

## Config

Kyoso は次の順に config を load します。

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`、または `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- `--network` などの CLI flags と `--set agents.claude.effort=high` などの反復可能な overrides

`plan`、`security`、`diff` は、反復可能な `--set <key>=<value>` overrides を受け付けます。CLI で指定した値は config files より優先され、`--ignore-config` との併用も可能です。

- Agent keys: `agents.<codex|claude>.<enabled|model|effort|role|timeoutMs>`
- Verification keys: `verification.<enabled|maxFindings|timeoutMs>`
- Judge keys: `judge.<mode|provider|timeoutMs>`

未知の key は拒否されます。boolean / numeric config keys は schema の型へ変換し、string keys は文字列のまま保持した後、config 全体を再検証します。

Project `kyoso.toml` は declarative で、trust approval は不要です。tools toggles、agent `enabled` / `model` / `effort` / `role` / `timeoutMs`、workspace byte limits と additive `workspace.deny`、verification settings、advisory judge settings、tightening-only security/network settings を設定できます。

Global TOML は command 実行や env forwarding を含む user-owned settings 用です。

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` は deprecated ですが、互換性のため引き続き supported です。trust-on-first-use approval の後にのみ load され、trusted hashes は `~/.kyoso/trusted-configs.json` に保存されます。`kyoso.toml` と `kyoso.config.ts` が両方ある場合、Kyoso は TOML を使用し TypeScript config を無視します。

Default agent timeouts は Codex 120 秒、Claude 300 秒です。MCP clients は tool calls に少なくとも 360 秒を許可してください。`verification.enabled` が true の場合、Kyoso は追加の cross-agent verification round を実行することがあるため、少なくとも 480 秒を許可してください。

Optional finding verification は default で disabled です:

```toml
[verification]
enabled = false
maxFindings = 5
timeoutMs = 90000
# global config only; project kyoso.toml cannot set this
allowDemotion = false
```

Enabled の場合、Kyoso は high/critical かつ single-source の各 finding について、その finding を報告していない agent に反証を試みさせます。Phase 1 は annotate-only です。verification は finding confidence と notes を更新できますが、severity や final decision は変更しません。`allowDemotion` は future opt-in phase 用に予約されており、現時点では no-op です。

Judge LLMs は optional です。OpenAI judge を使うには `OPENAI_API_KEY` または `CODEX_API_KEY` を設定し、Anthropic judge を使うには `ANTHROPIC_API_KEY` を設定します。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults は意図的に lightweight models を使用します。より強い judge を使う場合は、`KYOSO_ANTHROPIC_JUDGE_MODEL` に `claude-sonnet-5` のような Sonnet-class model を設定してください。

Subscription-only setup:

- Codex: local `codex` login を使用
- Claude: `claude setup-token` を実行し、`CLAUDE_CODE_OAUTH_TOKEN` を設定
- Judge: API keys を設定しないことで、Kyoso は `deterministic_fallback` を使用
- `OPENAI_API_KEY` が存在するときに OpenAI judge calls を避けるには、`judge.provider = "none"` を設定

Team admins は organization Usage credits も確認してください。Credits が有効な場合、subscription limits を超える billing behavior は Kyoso の外側で制御されます。

## Troubleshooting

- MCP timeout: client tool timeouts を少なくとも 360 秒、`verification.enabled` が true の場合は少なくとも 480 秒に設定してください。Kyoso defaults は Codex 120 秒、Claude 300 秒、verification 90 秒です。
- Fresh npm release: safe-chain などの minimum-package-age protection により、publish 直後は `npx @kyo-so/cli` の解決が一時的に block される場合があります。
- Deprecated TypeScript config: `--trust-config` を渡さない限り、untrusted `kyoso.config.ts` は skip されます。新規設定は `kyoso.toml` を使ってください。

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; production では設定しないでください。
- `KYOSO_KEEP_TEMP=1`: local debugging 用に temporary snapshots を保持します。

## License

Kyoso は GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) で licensed されています。

Kyoso は separate CLI または MCP server process として使うことを想定しています。Kyoso を他の program に embedding、importing、linking する場合、license implications が異なる可能性があります。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
