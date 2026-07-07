# Kyo-so

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/hokupod/kyoso)

[English](README.md) | [日本語](README.ja.md) | [简体中文](README.zh-CN.md)

この翻訳は英語版より古い場合があります。最新の情報は英語版 README を参照してください。

Kyo-so (Kyoso / 協奏) は、AI coding workflow 向けの MCP-native、ACP-powered な multi-agent review gate です。

「協奏」という名前には、複数の独立した奏者がそれぞれの役割を保ちながら、ひとつの成果をつくるという意味を込めています。

Kyo-so は Codex と Claude の reviewer を連携させ、次のレビューを行います。

- implementation plan review
- CISA Secure by Design gate による security review
- 実装後の diff review

Kyoso はコード変更を適用しません。

## Quick Start

グローバルインストールは不要です。Kyoso は `npx` または `bunx` で実行します。

### Claude Only / Codex Only

Kyoso は Claude だけ、または Codex だけでも実行できます。利用できない backend は `kyoso.config.ts` で無効化してください。例は `examples/claude-only.config.ts` と `examples/codex-only.config.ts` にあります。

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
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
```

パッケージ化された CLI を実行するには Node.js 20 以降が必要です。

既知の配布リスク: `@modelcontextprotocol/server` にはまだ stable release がありません。Kyoso は現在 prerelease API を pin しているため、MCP SDK API の変更に追従する follow-up release が必要になる場合があります。

## CLI

通常の実行経路は `npx @kyo-so/cli` と `bunx @kyo-so/cli` です。以下の例では、この prefix を `kyoso` と省略しています。

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

`npx @kyo-so/cli setup codex --write` と `bunx @kyo-so/cli setup codex --write` は、既定で `.agents/skills/kyoso-review/` にコピーします。`--global` を追加すると `~/.agents/skills/kyoso-review/` にコピーします。

`npx @kyo-so/cli setup claude-code --write` と `bunx @kyo-so/cli setup claude-code --write` は、既定で `.claude/skills/kyoso-review/` にコピーします。`--global` を追加すると `~/.claude/skills/kyoso-review/` にコピーします。

## Safety Model

Kyoso MVP は disposable temporary snapshot と policy-level write denial を使用します。完全な OS sandbox ではありません。リスクを理解していない場合、untrusted repositories に対して Kyoso を実行しないでください。

Secret detection は best-effort です。Kyoso は request、selected files、diff 内で secret らしき値を検出すると、その値を redact し、既定では backend agents の実行前に block します。

Kyoso は provider credentials を保存しません。Child agent environment variables は allowlist されます。

Repository content、plans、diffs、selected files は backend prompts 内で untrusted data として扱われます。Kyoso はそれらを `<untrusted-content>` tags で包み、その中にある instructions に従わないよう agents に指示します。最終判断は schema-constrained findings から導出されます。agents は files の書き込みや commands の実行ができず、judge は deterministic decision を変更できません。

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

## Agent Models

`agents.<name>.model` を省略すると、各 agent 独自の default を使用します。Codex は `~/.codex/config.toml` などの local Codex config を使用し、Claude は adapter default を使用します。

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

Kyoso は model pins を adapter-supported configuration に mapping します。

- Claude: `agents.claude.env` または whitelisted parent env で未設定の場合に `ANTHROPIC_MODEL` を設定します。
- Codex: `CODEX_CONFIG` が未設定の場合、`CODEX_CONFIG={"model":"..."}` を設定します。model pin と他の Codex session config を組み合わせるには、`agents.codex.env.CODEX_CONFIG` を直接設定してください。

## Audit

Audit traces は次の場所に書き込まれます。

```text
.kyoso/traces/<yyyy-mm-dd>/<traceId>.jsonl
```

Raw agent output と raw file contents は既定で無効です。

`.kyoso/traces/` を Git に含めないでください。`kyoso init` は `.kyoso/` を `.gitignore` に追加し、この repository も同じ設定にしています。`audit.includeRawAgentOutput` を有効にすると、traces に sensitive review output が残る場合があります。local retention policy に従って古い traces を定期的に削除してください。

## Config

`kyoso.config.ts` は trust-on-first-use approval の後にのみ load されます。Trusted hashes は `~/.kyoso/trusted-configs.json` に保存されます。

TypeScript config files は任意の code を実行できます。TTY では、untrusted config を実行する前に Kyoso が確認します。MCP や CI のような non-interactive mode では、untrusted config は skip され、defaults が使われます。現在の config hash を明示的に trust するには `--trust-config` を渡し、常に defaults を使うには `--ignore-config` を渡してください。

Default agent timeouts は Codex 120 秒、Claude 240 秒です。MCP clients は tool calls に少なくとも 360 秒を許可してください。

Judge LLMs は optional です。OpenAI judge を使うには `OPENAI_API_KEY` または `CODEX_API_KEY` を設定し、Anthropic judge を使うには `ANTHROPIC_API_KEY` を設定します。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults は意図的に lightweight models を使用します。より強い judge を使う場合は、`KYOSO_ANTHROPIC_JUDGE_MODEL` に `claude-sonnet-5` のような Sonnet-class model を設定してください。

Subscription-only setup:

- Codex: local `codex` login を使用
- Claude: `claude setup-token` を実行し、`CLAUDE_CODE_OAUTH_TOKEN` を設定
- Judge: API keys を設定しないことで、Kyoso は `deterministic_fallback` を使用
- `OPENAI_API_KEY` が存在するときに OpenAI judge calls を避けるには、`judgeProvider: "none"` を設定

Team admins は organization Usage credits も確認してください。Credits が有効な場合、subscription limits を超える billing behavior は Kyoso の外側で制御されます。

## Troubleshooting

- MCP timeout: client tool timeouts を少なくとも 360 秒に設定してください。Kyoso defaults は Codex 120 秒、Claude 240 秒です。
- Fresh npm release: safe-chain などの minimum-package-age protection により、publish 直後は `npx @kyo-so/cli` の解決が一時的に block される場合があります。
- Non-interactive config: `--trust-config` を渡さない限り、untrusted `kyoso.config.ts` は skip されます。

## Development

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; production では設定しないでください。
- `KYOSO_KEEP_TEMP=1`: local debugging 用に temporary snapshots を保持します。

## License

Kyoso は GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) で licensed されています。

Kyoso は separate CLI または MCP server process として使うことを想定しています。Kyoso を他の program に embedding、importing、linking する場合、license implications が異なる可能性があります。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
