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

backend が 1 つだけ有効な場合は、2 role の ensemble の代わりに 1 agent が `combined_reviewer` として実行されます([Single-backend mode](#single-backend-mode) を参照)。この図の Mermaid ソースは [docs/assets/](docs/assets/) にあります。

## Quick Start

グローバルインストールは不要です。Kyoso は `npx` または `bunx` で実行します。パッケージ化された CLI を実行するには Node.js 20 以降が必要です。

### 導入モード

| モード             | 導入物                   |  MCP | 対象               |
| ------------------ | ------------------------ | ---: | ------------------ |
| Marketplace Plugin | Skill＋ローカルstdio MCP | あり | Codex／Claude Code |
| CLI＋Skill-only    | npm CLI＋Skill           | なし | Codex／Claude Code |
| 手動setup          | 手動MCP登録＋Skill       | あり | Codex／Claude Code |

迷ったらMarketplace Pluginを選んでください。2コマンドでSkillとMCP serverをまとめて導入できます。手順は下の[Codex](#codex)／[Claude Code](#claude-code)節を参照してください。導入モードを後から切り替える場合は[移行](#移行)を参照してください。

#### Marketplace Plugin

PluginはSkillと公開済みのKyoso CLIの完全一致versionへpinしたMCP定義を同梱しますが、CLI本体は同梱しません。MCPの初回起動ではnpmへのnetwork accessが必要です。cache済みpackageでoffline起動できる場合はありますが、保証しません。manifestの`Read` capabilityは表示metadataであり、filesystem認可を追加するものではありません。

PluginのSkillは同梱の`kyoso` MCP serverをdependencyとして宣言するため、Kyoso reviewの明示的な実行はCLI fallbackではなくMCPへ誘導されます。同梱Plugin MCPを無効化した場合は、Plugin Skillを利用不可として扱います。MCPを再有効化するか、Pluginを削除してCLI＋Skill-onlyへ移行してください。PluginはCLI fallback modeではありません。

Plugin経由のOpenRouter key転送については、[Codex の OpenRouter project opt-in](#codex-の-openrouter-project-opt-in) を参照してください。

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

Skill-onlyは意図的にMCP dependencyを宣言しません。`npx`または`bunx`のpackage-runner fallbackに到達すると、Codex Auto modeはsandbox network escalation approvalを要求することがあります。PATH上に`kyoso`を導入すると、このfallbackを避けられます。

### Claude Code

1. Claude 認証を準備します。

```bash
claude setup-token
```

このコマンドで得た `CLAUDE_CODE_OAUTH_TOKEN` を設定するか、直接 API 課金を使う場合は `ANTHROPIC_API_KEY` を設定します。

2. Marketplace Plugin を導入します(推奨)。

```text
/plugin marketplace add hokupod/kyoso
/plugin install kyoso@kyoso
```

Plugin は Kyoso review Skill と、公開済み CLI version に pin したローカル stdio MCP server を導入します。Plugin で導入した場合、`kyoso setup claude-code` は不要です。

3. または、MCP を登録して review skill をインストールします。

```bash
npx -y --package=@kyo-so/cli kyoso setup claude-code --write
bunx --package @kyo-so/cli kyoso setup claude-code --write
```

手動で MCP を登録する場合は、`examples/claude-code-mcp.json` を使用します。

4. セットアップを確認します。

```bash
npx -y --package=@kyo-so/cli kyoso doctor
bunx --package @kyo-so/cli kyoso doctor
```

5. Claude Code からレビューを依頼します。

```text
Use Kyoso plan_review on this plan before implementation.
```

### Codex

1. Codex 認証を準備します。

```bash
codex login
```

2. Marketplace Plugin を導入します(推奨)。

```bash
codex plugin marketplace add hokupod/kyoso
codex plugin add kyoso@kyoso
```

Codex desktopのPlugins pageまたは`/plugins`からKyosoを選ぶこともできます。追加したMarketplaceが見えない場合はdesktop appをrefresh／restartしてください。確認は`codex plugin list --marketplace kyoso --json`、削除は`codex plugin remove kyoso@kyoso`です。Plugin で導入した場合、`kyoso setup codex` は不要です。

Codex Auto modeでは、approvalが必要なKyoso toolの呼び出しが拒否されることがあります。個人設定で事前承認する方法は [Codex approval prompts](#codex-approval-prompts) を参照してください。

3. または、MCP を登録して review skill をインストールします。

```bash
npx -y --package=@kyo-so/cli kyoso setup codex --write
bunx --package @kyo-so/cli kyoso setup codex --write
```

4. セットアップを確認します。

```bash
npx -y --package=@kyo-so/cli kyoso doctor
bunx --package @kyo-so/cli kyoso doctor
```

5. Codex からレビューを依頼します。

```text
Use Kyoso diff_review on the current diff. I need a second opinion before merging.
```

手動セットアップ用の例は `examples/codex-config.toml` と `examples/claude-code-mcp.json` にあります。

## CLI

package-runner の実行経路では、package と executable を必ず別指定します: `npx -y --package=@kyo-so/cli kyoso` と `bunx --package @kyo-so/cli kyoso` です。workflowで固定する場合は、`@kyo-so/cli@0.13.1` のようにpackage名へcomplete SemVer pinを付けます。以下の例の `kyoso` は、すでにインストールされた executable の省略形です。Naming note: npm パッケージは `@kyo-so/cli` (製品名 Kyo-so に対応) で、インストールされる CLI コマンドは短い `kyoso` です。

Bun fallback は Bun `1.3.14` で検証済みです。古い Bun では npx 形式またはインストール済みの `kyoso` を使い、複数bin packageからの Bun のbinary推論に依存しないでください。

```bash
kyoso plan --goal "Review this OAuth callback plan" --plan plan.md
kyoso security --goal "Review this auth diff" --diff changes.patch
kyoso diff --base main --head HEAD --focus architecture --set agents.claude.effort=high
kyoso doctor
kyoso init
kyoso setup codex
kyoso setup claude-code
kyoso setup codex --write --skill-only
kyoso setup claude-code --write --skill-only
```

## Usage Examples

選択したコードと一緒に implementation plan をレビューします。

```bash
kyoso plan \
  --goal "Review the OAuth callback implementation plan" \
  --plan plan.md \
  --file src/auth/callback.ts
```

結果は上から順に読んでください。`Decision` は deterministic gate の結果、`Coverage` は実行した必須観点と役割、各 finding の `disposition` は block 対象か参考情報かを示します([Review contract と finding admission](#review-contract-と-finding-admission) を参照)。

patch に対して CISA Secure by Design security review を実行します。

```bash
kyoso security \
  --goal "Review auth changes for tenant isolation and secure defaults" \
  --diff changes.patch \
  --json
```

JSON output では、`cisaSecureByDesign` に設定済み dimensions と gate enforcement の有効状態が表示されます。backend が返す raw dimension status は計算と decision では無視し、付随する notes だけを advisory として保持します。Kyoso は採用済み findings から status を計算します。enforcement 有効時の customer security outcomes の `fail` は review を block します。

Kyoso を Codex または Claude Code の MCP server として登録し、client から `plan_review` を呼び出します。

```toml
# See examples/codex-config.toml
[mcp_servers.kyoso]
command = "npx"
args = ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"]
```

client request の例:

```text
Use Kyoso plan_review on this plan and the selected auth files. I need a second opinion before implementing.
```

## MCP

```bash
npx -y --package=@kyo-so/cli kyoso mcp --network model_only
bunx --package @kyo-so/cli kyoso mcp --network model_only
```

`--network` を省略すると、Kyoso は `model_only` を使用します。これは Kyoso が backend agents からの通信を model-provider traffic のみにすることを期待する policy-level constraint です。OS-level network isolation ではありません。

Kyoso が公開する MCP tools は次の 3 つだけです。

- `plan_review`
- `security_review`
- `diff_review`

MCP stdout は protocol messages 専用です。logs は stderr または local audit traces に出力されます。

## Skill

同梱の `kyoso-review` skill は意図的に狭い用途にしています。Kyoso、multi-agent review、plan review、security review、CISA Secure by Design review、diff review を明示的に依頼したときだけ trigger されるべきです。

Skillは利用可能な最初の経路を使います。順序はKyoso MCP tools、PATH上のインストール済み`kyoso`、`npx -y --package=@kyo-so/cli kyoso`、`bunx --package @kyo-so/cli kyoso`です。package runner fallbackはnetwork accessが必要になり、pinなしでは新しいreleaseへ解決され得るため、MCPなしの通常経路にはインストール済みCLIを使います。typed [review contract](#review-contract-と-finding-admission) にnon-goalsまたはaccepted risksがありMCPを利用できない場合、CLI fallbackは`focus`しか保持できないためSkillは停止します。

`kyoso setup codex --write --skill-only`はcanonical Skill directoryを既定で`.agents/skills/kyoso-review/`へコピーします。`--global`を追加すると`~/.agents/skills/kyoso-review/`へコピーします。

`kyoso setup claude-code --write --skill-only`は既定で`.claude/skills/kyoso-review/`へコピーします。`--global`を追加すると`~/.claude/skills/kyoso-review/`へコピーします。

managed installはcanonical directoryのdigestとCLI versionを`.kyoso-install.json`へ記録します。現行または既知historical copyはadoptして自動更新します。変更済み／未知のcopyはconflictとして残し、上書きしません。`--force`はそのmanaged Skillを置換できます。manual MCPに対する例外は次節の限定移行だけであり、custom／unknown登録、選択した安全な対象外のglobal／nested登録、Marketplace Plugin／cacheは変更しません。

### 手動 MCP の移行

最初に `kyoso setup codex` または `kyoso setup claude-code` を実行し、既存登録を確認します。dry-run と `--write` は既存の MCP entry をすべて保持します。`--write --force` は認識済みの完全一致 legacy npx Kyoso command を上記の package と executable を分離した形式へ移行します。完全一致 legacy bunx command は `--runner` を省略するとprobeせず保持します。`--write --runner bunx --force` は Bun を検証して明示bunx形式へ移行し、`--write --runner npx --force` は意図的にnpx形式へ移行します。いずれもlegacy commandにcomplete SemVer pinがあった場合は保持します。

`--force` が対象にできるのは managed Skill の置換と、上記runner policyに従う完全一致 legacy MCP entry の移行だけです。custom `--command` entry、unknown structure、選択対象外の global / nested registration、Marketplace Plugin / cache は変更しません。`kyoso doctor` は保持したentryを ready とせず、`legacy`、`custom-unverified`、`unknown` として表示します。examplesを使って手動修復してから doctor を再実行してください。

## Review contract と finding admission

すべての review で、correctness、regression、security boundaries、secrets/injection、data integrity、public contract を削除不能な safety floor として確認します。review の形状に応じて supply chain、privacy、resource amplification も追加します。user-global `reviewPolicy.additionalLenses` は観点を追加できますが、floor は削除できません。

MCP / library caller は型付き `reviewContract`、CLI caller は反復可能な `--focus <lens>` を指定できます。

```json
{
  "reviewContract": {
    "focus": ["architecture"],
    "nonGoals": ["この変更では public CLI を再設計しない"],
    "acceptedRisks": [
      {
        "findingFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "rationale": "次回リリースで対応を追跡する"
      }
    ]
  }
}
```

non-goals と accepted risks は、caller が明示した user-owned value だけを使用します。repository constraints、plans、diffs、files は untrusted context のままで、review policy を変更できません。non-goals は optional scope を限定しますが、agent由来のpolicy labelでdispositionを変更しません。accepted risksは検証済みfingerprintとの完全一致でのみMedium findingへ影響します。どちらもCritical / Highのsafety findingを抑制しません。

Kyoso は各 finding の evidence quality、対象変更との関係、stable fingerprint、disposition を再計算します。

| Disposition  | 意味                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `gate`       | 変更が導入または悪化させた、具体的根拠のある Critical / High。                                                   |
| `actionable` | 変更が導入または悪化させた、具体的根拠のある Medium。                                                            |
| `advisory`   | optional / Low / Info、accepted Medium、またはpre-existing・partial・根拠不足のMedium。                          |
| `disputed`   | refuted、low-confidence、根拠不足、pre-existing、または独立review未解決のCritical / High。人の判断を必要とする。 |

deterministic decision に影響するのは `gate` と `actionable` だけです。`disputed` は completion を incomplete にし、自動修正してはいけません。`coverage` は required/attempted lenses、required/completed perspectives、独立した cross-model review の有無を記録します。`Tests to Add` は具体的な regression test を最大3件に制限し、generic command や広範な test-suite 要求は除外します。

## Configuration

### Files and precedence

Kyoso は次の順に config を load します。

- built-in defaults
- user global TOML: `$XDG_CONFIG_HOME/kyoso/config.toml`、または `~/.config/kyoso/config.toml`
- project TOML: `<cwd>/kyoso.toml`
- `--network` などの CLI flags と `--set agents.claude.effort=high` などの反復可能な overrides

`plan`、`security`、`diff` は、反復可能な `--set <key>=<value>` overrides を受け付けます。CLI で指定した値は config files より優先され、`--ignore-config` との併用も可能です。

未知の key は拒否されます。boolean / numeric config keys は schema の型へ変換し、string keys は文字列のまま保持した後、config 全体を再検証します。

Project `kyoso.toml` は declarative で、trust approval は不要です。agent `enabled` / `model` / `effort` / `role` / `timeoutMs`、user global authorization後のCodex専用`provider`または継承したOpenRouterのmodel上書き、workspace byte limits と additive `workspace.deny`、verification settings、advisory judge settings、tightening-only security/network/CISA settings を設定できます。

`entrypoints.*`、`tools.*`、`reviewPolicy.*` は user-global policy です。entrypoint または tool が disabled の場合、agents の起動前に structured policy block を返します。`firstClassClient = "codex"`、`workspace.readOnly = true`、`network.mediatedWeb.enabled = false`、`audit.includeFileContents = false` は fixed / reserved value であり、未対応値は no-op にせず拒否します。

Global TOML は command 実行や env forwarding を含む user-owned settings 用です。

```toml
[agents.codex]
command = "bunx"
args = ["@agentclientprotocol/codex-acp"]

[agents.codex.env]
CODEX_CONFIG = '{"model":"gpt-5.5"}'
```

`kyoso.config.ts` は deprecated ですが、互換性のため引き続き supported です。trust-on-first-use approval の後にのみ load され、trusted hashes は `~/.kyoso/trusted-configs.json` に保存されます。`kyoso.toml` と `kyoso.config.ts` が両方ある場合、Kyoso は TOML を使用し TypeScript config を無視します。

### Agents

Agent keys: `agents.<codex|claude>.<enabled|model|effort|role|timeoutMs>`。Codexには`agents.codex.provider`もあり、`"openrouter"`はexternal providerを選択し、`"default"`は継承したOpenRouter選択を通常のCodex behaviorへ戻します。Claudeにprovider設定はありません。projectから`provider`を選択するには、global config専用の`agents.codex.allowProjectProvider` allowlistが必要です。詳細な規則は [Codex の OpenRouter project opt-in](#codex-の-openrouter-project-opt-in) を参照してください。`command` / `args` / `env`もglobal config専用です([Files and precedence](#files-and-precedence) を参照)。

`agents.<name>.model` または `agents.<name>.effort` を省略すると、各 agent 独自の default を使用します。Codex は `~/.codex/config.toml`（`CODEX_HOME`を設定している場合は`$CODEX_HOME/config.toml`）などの local Codex config を使用し、Claude は adapter default を使用します。

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

### Codex の OpenRouter project opt-in

まずuser global configでproject-level OpenRouter routingを許可します。

```toml
# ~/.config/kyoso/config.toml
[agents.codex]
allowProjectProvider = ["/absolute/path/to/project"]
```

続けてOpenRouterが必要なprojectだけでopt-inします。

```toml
# <project>/kyoso.toml
[agents.codex]
provider = "openrouter"
model = "openai/o4-mini"
```

`provider = "openrouter"` の場合、`model`は空白でない値が必須です。これはOpenRouterのmodel IDです。Kyosoはcatalogやtool calling対応を検証しないため、利用するmodelのtool supportはproviderで確認してください。

`allowProjectProvider`はprojectの`provider`と、OpenRouterを継承中のproject `model`上書きに必要で、listには解決後のproject config fileを含むcanonical directoryのabsolute pathを完全一致で指定します。invocationのcwdやlexical pathではありません。descendantやglobには一致しません。trusted `kyoso.config.ts`を含むproject config fileとallowlist entryの両方をsymlink経由も含めて同じdirectoryのreal pathへ解決して比較するため、そのdirectoryへ解決されるentryは一致し、別の場所へ解決されるentryまたは解決できないpathはfail closedです。user globalの`provider = "openrouter"`にはallowlist entryは不要です。CLIで選択する場合は、同一 invocation に`--set agents.codex.provider=openrouter`と`--set agents.codex.model=<model>`の両方が必要であり、project modelで前者を補完することはできません。`allowProjectProvider`は`--set` pathではなく、legacy boolean値は拒否されます。

user global configがOpenRouterを選択している場合、projectは`provider = "default"`で明示的にopt-outできます。このresetにはmodelもauthorizationも不要で、同じlayerで通常のCodex modelを明示しない限り継承したOpenRouter modelも消去し、そのprojectではOpenRouter keyをforwardしません。

Kyosoを起動するCodexまたはClaude client processのenvironmentにkeyを設定します。直接のenvironment variableをprimary pathとし、1Passwordなどのsecret managerはoptionalでKyosoの依存ではありません。

```bash
export OPENROUTER_API_KEY="<secret>"
```

keyは`kyoso.toml`、Git管理するconfig、Audit trace、review outputへ保存しません。KyosoはKyoso processまたは明示した`agents.codex.env`のいずれのsourceであっても、このproviderを選択した場合だけCodex childへ転送します。`provider`を省略するか`provider = "default"`の場合は、両方のsourceを意図的に転送しません。空でない明示的な`agents.codex.env.OPENROUTER_API_KEY`は、転送しなかったことを示すsanitized warningも出します。選択されたCodex OpenRouter childだけがkeyを受け取れるため、`agents.claude.env`など別のchild configurationに空でないkeyがある場合も同じwarningを出します。`provider`を省略すると既存のCodex login、`OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_CONFIG`の挙動を維持し、行を削除するとその挙動へ戻ります。

Marketplace PluginはMCP processへ`OPENROUTER_API_KEY`の変数名を公開しますが、credential値は保存しません。GUI clientはshell exportを継承しない場合があります。新規manual MCP registrationは`kyoso setup <client> --write --with-openrouter`で作成し、clientを再起動してから`kyoso doctor`でKyoso processがkeyを検出できるか確認してください。`kyoso setup`は既存のMCP entryを再書換えせずに保持するため、既存registrationでは[examples](examples/codex-config.toml)を参照してopt-in allowlistを手動更新する必要があります。

新規manual MCP registrationは既定で`OPENROUTER_API_KEY`を含めません。providerを意図して選択した後だけ`--with-openrouter`で追加し、既存registrationは書換えません。`kyoso setup ... --with-openrouter` の出力と手動セットアップ例は、引き続き利用者が管理するクライアント登録テンプレートです。Claude Code registrationの`${OPENROUTER_API_KEY}`はclientが展開する必要があり、Kyosoは`${NAME}`、`$NAME`、`%NAME%`（前後の空白は許容）だけから成る未展開credential placeholderだけを無視し、変数名だけを含むsanitized warningを出します。ほかの文字列を含む値は維持します。custom credential-like nameの末尾が`_KEY`、`_TOKEN`、`_SECRET`、`_PASSWORD`である場合にも同じ規則を適用し、credentialではないtemplateは維持されます。

このuser-authorized project-scoped opt-inを推奨します。global `provider = "openrouter"`は、projectが`provider = "default"`を設定するまで継承されます。`provider`の省略だけでは解除されません。固定のOpenRouter Responses API presetはbetaです。custom endpoint、provider routing、fallback、judge integrationは公開しません。keyをこのpresetに束縛するため、OpenRouter modeではtop-levelの`profile`または`profiles`を含む`CODEX_CONFIG`と、objectではない`model_providers` valueをchild起動前に拒否します。objectの場合は`model_providers`を固定の`kyoso-openrouter` entryだけに置換し、破棄したentry数だけを含むsanitized warningを出します。provider IDやconfig valueは出力しません。拒否するfield以外では、`model`、`model_provider`、`model_providers`以外のunrelatedな`CODEX_CONFIG` fieldを維持するため、foreign provider configurationがkey付きのendpointを選択することはできません。Claudeは設定済みproviderのままで、judgeは`OPENROUTER_API_KEY`を使用しません。

user global authorization後、projectの`kyoso.toml`はexternal providerを選択、または継承したOpenRouter modelを上書きし、review contextをそこへ送ることがあります。untrusted repositoryでは`--ignore-config`を使用し、必要なCLI optionsだけを明示してください。

実際のCodex ACP/OpenRouter smokeはrelease-gatedであり、testでは実行しません。networkと課金が明示許可された後だけ、client environmentへkeyをexportして次を実行します。

```bash
KYOSO_OPENROUTER_ACP_SMOKE=release KYOSO_OPENROUTER_MODEL=<model> safe-chain bun run smoke:openrouter:codex-acp
```

このcommandはCLI argumentsを受け付けず、pinしたCodex ACP adapterを使います。呼び出し元のrepositoryやcached Codex loginを利用しないよう、空のtemporary workspace、`HOME`、`CODEX_HOME`を新規作成し、key/modelをconfig・temporary artifact・outputへ書かずに固定の成功または失敗メッセージだけを返します。

### Agent auth

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

`OPENROUTER_API_KEY`は通常のCodex allowlistには意図的に含めません。`agents.codex.provider = "openrouter"`の場合だけKyoso processからcopyし、keyがないか空の場合はCodex childを起動せず、構造化されたagent failureとして返します。別reviewerはdegraded modeで継続できます。

資格情報露出を最小化するため、OpenRouter modeでは`OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN`をCodex childから除外します。local adapter state用に`CODEX_HOME`は残ります。そのためadapterはlocal login cacheを読み取れ、これはcredential isolationではなくdefense in depthです。

Kyoso は subprocesses の起動に必要な最小限の runtime env も forward します: `PATH`, `HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, `SHELL`, `USER`, `USERNAME`, `SystemRoot`。

Subscription-only setup:

- Codex: local `codex` login を使用
- Claude: `claude setup-token` を実行し、`CLAUDE_CODE_OAUTH_TOKEN` を設定
- Judge: default の `deterministic_only` mode は API key を必要としません([Judge](#judge) を参照)
- 明示的な LLM judge opt-in を無効化するには、`judge.mode = "deterministic_only"` または `judge.provider = "none"` を設定

Team admins は organization Usage credits も確認してください。Credits が有効な場合、subscription limits を超える billing behavior は Kyoso の外側で制御されます。

### Single-backend mode

Kyoso は Claude だけ、または Codex だけでも実行できます。利用できない backend は `kyoso.toml` で無効化してください。例は `examples/claude-only.toml` と `examples/codex-only.toml` にあります。

single-agent mode では、残った backend が `combined_reviewer` として1回実行され、implementation と architecture/security の両 perspective を担当します。JSON output は `reviewMode: "single_agent"`、`agentsUsed`、`coverage.independentReview: false` を含み、Markdown output は cross-model verification を実行していないことを示します。user-global `reviewPolicy.multiAgentRequired = true` を設定すると、この degraded coverage を incomplete として block します。

この mode では独立した cross-model validation はなく、自己レビュー bias が残ります。一方で、別プロセスの read-only review、temporary snapshots、adversarial review prompts、secret scanning、deterministic gates は利用できます。

### Execution budget and review stopping

各 review には、model call数、総 wall time、streaming中のagent text（message / thought chunk）に user-global の hard ceiling があります。streaming textにはより低いsoft warning thresholdがあり、agentあたりのfinding数はsoft targetです。

```toml
[reviewBudget]
maxModelCalls = 4
maxTotalWallTimeMs = 660000
warnAgentOutputBytes = 524288
maxAgentOutputBytes = 1048576
maxFindingsPerAgent = 10
skipOptionalPhasesWhenTokenUsageUnknown = false
```

`reviewBudget` は user-global 専用です。project `kyoso.toml` と `--set` では変更できません。MCP / library request は `options.reviewBudget` で ceiling を下げることだけができ、引き上げはできません。512 KiBのwarningはnon-blocking、1 MiBのlimitはcallをcancelし、10件のfinding targetを超えたmaterial findingも破棄しません。token usage不明時は既定でwarningを出して継続し、user-globalで明示的に`true`を設定した場合だけ厳格なoptional-phase skipを維持します。Kyoso は primary reviewer を両方予約してから開始し、残りのcallだけを verification に使い、LLM Judge は advisory として扱います。既定のJudge modeは `deterministic_only` です。

結果には `completion`、`executionBudget`、`requestFingerprint` が含まれます。Markdown と Audit は call数、wall time、message / thought / total output bytes、reported / partial / unknown token usage を示します。完了したmodel callは`executionIdentity`も提示でき、Kyosoのrouteとrequested modelをprovider-reported identityから分離します。requested-only valueをprovider報告値として表示しません。`completion.status` が `incomplete` の場合、Kyoso は `retryable: false` の通常の `block` 結果を返します。これは code defect の断定ではなく、review coverage が未完了であることを意味します。同じ fingerprint を自動 retry しないでください。同一review checkpointでは、bundled Skill は初回1 passと material fix後の確認1 passだけを許可し、3回目には明示的な user approval が必要です。

### Timeouts

Default agent timeout は Codex / Claude ともに600秒です。verification round の default は 90 秒です。review全体のdeadlineは既定660秒(`reviewBudget.maxTotalWallTimeMs`)で、defaultの並列primary phase後に標準の60秒のfinalization余裕を確保します。各phaseはdeadlineを延長せず残り時間を使います。`kyoso doctor` は設定済みの直列phase時間と、10%または60秒の大きい方を余裕として加えたreview-wide推奨値を表示します。LLM judge timeoutは、judge modeが許し、direct provider credentialが利用できる場合だけ加算します。

このrepositoryのprimary 15分＋verification 15分のdogfooding presetでは、次のuser-global overrideを使います。

```toml
[reviewBudget]
maxTotalWallTimeMs = 2100000
```

Codex Pluginと新規生成するmanual Codex registrationは`tool_timeout_sec = 2160`を使い、Kyosoの35分deadlineより60秒長く待機します。既存manual registrationは`kyoso setup`が保持するため、手動更新が必要です。Claude Code Plugin manifestはclient tool timeoutを設定しないため、同値をミリ秒で指定してClaude Codeを起動し、clientを再起動してください。

```bash
MCP_TOOL_TIMEOUT=2160000 claude
```

client timeoutを延ばしてもKyoso内部のreview-wide deadlineは延長されません。ほかのpresetでは、client timeoutを`reviewBudget.maxTotalWallTimeMs`より長くしてください。

### Verification

Verification keys: `verification.<enabled|maxFindings|timeoutMs>`。Optional finding verification は default で disabled です:

```toml
[verification]
enabled = false
maxFindings = 5
timeoutMs = 90000
# global config only; project kyoso.toml cannot set this
allowDemotion = false
```

Enabled の場合、Kyoso は high/critical かつ single-source の各 finding について、その finding を報告していない agent に反証を試みさせます。verification は annotate-only で、confidence と notes は更新できますが、severity は変更しません。反証済みまたは未解決の material finding は `disputed` になり、skip / fail / budget不足 / overflow の場合は `not_verified` のまま coverage incomplete を返します。これにより、第2の model が元の risk signal を暗黙に demote することを防ぎます。`allowDemotion` は compatibility のため受理しますが reserved で、どちらの値にも demotion effect はありません。

### Judge

Judge keys: `judge.<mode|provider|timeoutMs>`。Judge LLMs は optional で、default は `mode = "deterministic_only"` です。credential だけでは judge call を開始しません。OpenAI judge は `mode = "deterministic_plus_llm"` と `OPENAI_API_KEY` または `CODEX_API_KEY`、Anthropic judge は同modeと `ANTHROPIC_API_KEY` を設定します。Optional overrides:

- `OPENAI_BASE_URL`: OpenAI-compatible API base URL
- `KYOSO_OPENAI_JUDGE_MODEL`: OpenAI judge model, default `gpt-5.4-mini`
- `KYOSO_ANTHROPIC_JUDGE_MODEL`: Anthropic judge model, default `claude-haiku-4-5`

Judge defaults は意図的に lightweight models を使用します。より強い judge を使う場合は、`KYOSO_ANTHROPIC_JUDGE_MODEL` に `claude-sonnet-5` のような Sonnet-class model を設定してください。

### Audit

対応するPOSIX runtimeでは、Audit traces はuser state base（absoluteな`$XDG_STATE_HOME`、なければ`$HOME/.local/state`）配下の次の場所に書き込まれます。

```text
<state-base>/kyoso/workspaces/<sha256(realpath(cwd))>/<logical audit.directory>/<yyyy-mm-dd>/<traceId>.jsonl
```

`audit.directory`はlogicalなrelative directory（既定: `.kyoso/traces`）であり、workspace内のdirectoryではありません。既存のworkspace `.kyoso/traces`は自動で移行・削除されません。

installed packageからabsoluteなtrusted trace directoryを明示して、read-onlyのbudget reportを生成します。

```bash
kyoso-budget-report --trace-dir /absolute/path/to/traces --json
```

source checkoutではpackage scriptを使います。

```bash
bun run audit:budget-report -- --trace-dir /absolute/path/to/traces --json
```

reportはregularな`.jsonl`だけを再帰的に読み、symlinkをskipし、trace pathを推測しません。callをagent、kind、provider route、requested model、requested / reported identity status別に集計し、全callと正常系を分けたnearest-rankのp50 / p95 / p99 / max byte分布、token usage reporting率、output warning / limit率、completion / skip理由を表示します。正常系callは`resultStatus = "completed"`かつ`errorCode`なしを明示したeventだけです。曖昧なhistorical eventは全call統計だけに残します。top-levelのbyte分布とoutput warning / hard limitのcall率はprimaryとverifierだけを対象にし、judge callは全call数とexecution別集計へ残しつつ再較正指標を薄めません。warning call率には同じtrace / kind / agentのcompleted callへ対応付けられたwarning eventだけを含め、重複・孤立warning eventは別に表示します。JSONは固定された入力上限を`inputLimits`へ出し、file、byte、line、event、call、review、warning、group、reason、directoryのいずれかが上限を超えた場合は切り詰めずに停止します。走査は、検証済みcurrent directoryを指定rootのdevice / inodeへ固定した専用workerで行い、recursive descentでもdirectory identityを再検証するため、lexical rootを差し替えて元に戻しても読み取り先は変わりません。fileはsymlinkをfollowしないnon-blocking openで読み、discovery時のsizeを超えて消費しません。platformがこれらのopen capabilityを提供できなければreportを中止します。metadata sanitizeはdefense in depthであるため、operatorがtrustedと判断したtrace directoryだけを指定してください。bytesからtokenや費用を推定換算しません。再較正ではsoft warningを正常系p99の2倍以上に置き、hard breakerをwarningより十分高くして正常系発火率をほぼ0に保ち、policy変更前にprovider / model別のtoken usage unknown率を確認します。

Raw agent output は既定で無効です。`audit.includeFileContents` は reserved で `false` に固定され、この設定から file contents が保存されることはありません。`audit.includeRawAgentOutput`を有効にすると、traces に sensitive review output が残る場合があります。local retention policy に従って古い traces を削除してください。Windowsまたは安全なfilesystem capabilityを証明できない環境では、Audit trace writeは無効のままで、reviewはsanitized warningを返します([Safety Model](#safety-model) を参照)。

## Safety Model

Kyoso MVP は disposable temporary snapshot と policy-level write denial を使用します。完全な OS sandbox ではありません。リスクを理解していない場合、untrusted repositories に対して Kyoso を実行しないでください。

Secret detection は best-effort です。Kyoso は request、selected files、diff 内で secret らしき値を検出すると、その値を redact し、既定では backend agents の実行前に block します。

Kyoso は provider credentials を保存しません。Child agent environment variables は allowlist されます。

Repository content、plans、diffs、selected files は backend prompts 内で untrusted data として扱われます。Kyoso はそれらを `<untrusted-content>` tags で包み、その中にある instructions に従わないよう agents に指示します。最終判断は schema-constrained findings から導出されます。agents は files の書き込みや commands の実行ができず、judge は deterministic decision を変更できません。

Finding title は aggregation のため簡潔な英語に正規化されます。evidence、recommendations、summaries はユーザーの言語のままで構いません。

Audit trace は workspace が制御するpathではなく、trusted user state root 配下へ書き込みます。対応するPOSIX runtimeでは、absoluteな`$XDG_STATE_HOME`が利用可能ならそれを、そうでなければ`$HOME/.local/state`を使用し、owner、permission、containment、symlinkを確認できた場合だけ書き込みます。検証またはsafe openに失敗した場合、別locationへ黙ってfallbackせず、そのreviewのAudit writeを無効化してsanitized warningを返し、review自体は継続します。

Windows、および必要なfilesystem capabilityを証明できない環境では、Audit writeをfail-closeで無効化します。trusted state rootを変更できる、または検証済みinodeをrenameできるsame OS user権限のhostile processはこの保証の対象外です。この脅威にはOS sandboxまたはnative dirfd-based supportが必要です。

## 移行

### アップグレード時の注意

- Project `kyoso.toml` の `tools.*` は user-global config へ移してください。repository content が review を無効化できないよう、project-owned tool availability は拒否されます。

### 導入モードの切り替え

- 手動MCPからCLI＋Skill: CLIとSkillを先に導入し、`codex mcp remove kyoso`または`claude mcp remove kyoso --scope local|project|user`を実行します。
- CLI＋SkillからPlugin: Pluginを追加してenabledを確認してから、手動MCP登録を削除します。手動コピーSkillは自動削除しません。
- PluginからCLI＋Skill: CLIとSkillを先に導入し、`codex plugin remove kyoso@kyoso`を実行します。
- CLI＋Skillから手動MCPへ戻す: `kyoso setup codex --write`または`kyoso setup claude-code --write`を実行します。

## Troubleshooting

- MCP timeout: client timeoutはreview-wide deadlineより長くしてください。35分presetではCodexに2160秒、Claude Codeに`MCP_TOOL_TIMEOUT=2160000`を設定します。[Timeouts](#timeouts)を参照してください。
- Fresh npm release: safe-chain などの minimum-package-age protection により、publish 直後は `npx -y --package=@kyo-so/cli@<version> kyoso` が一時的に block される場合があります。`latest` や ambient `kyoso` へfallbackせず、その exact version を待ってください。
- Deprecated TypeScript config: `--trust-config` を渡さない限り、untrusted `kyoso.config.ts` は skip されます。新規設定は `kyoso.toml` を使ってください。
- OpenRouter key missing: 空でないCodex `model`、Kyoso processへ転送された`OPENROUTER_API_KEY`、clientの再起動を確認し、`kyoso doctor`を実行してください。Marketplace Plugin `0.4.0`以降はこの変数名をKyoso processへ転送し、それ以前のversionは転送しません。既存MCP registrationはsetupで再書換えされません。

### Codex approval prompts

Codex Auto modeでは、approvalが必要なKyoso toolの呼び出しが拒否されることがあります。個人設定で事前承認するには、次を`~/.codex/config.toml`（`CODEX_HOME`を設定している場合は`$CODEX_HOME/config.toml`）へ追加します。**Kyosoを信頼し、選択したコードとレビュー用contextが設定済みの外部model providerへ送信されることを許容できる場合だけ設定してください。** Pluginの既定値では有効にしていません。

```toml
[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.diff_review]
approval_mode = "approve"

[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.plan_review]
approval_mode = "approve"

[plugins."kyoso@kyoso".mcp_servers.kyoso.tools.security_review]
approval_mode = "approve"
```

Pluginではなく、MCP serverとして直接登録している場合（`kyoso setup codex --write` または手動設定）は、`plugins."kyoso@kyoso".` プレフィックスなしの `mcp_servers.kyoso` キーを使用します。

```toml
[mcp_servers.kyoso.tools.diff_review]
approval_mode = "approve"

[mcp_servers.kyoso.tools.plan_review]
approval_mode = "approve"

[mcp_servers.kyoso.tools.security_review]
approval_mode = "approve"
```

## Development

ローカル開発:

```bash
nix develop
safe-chain bun install
safe-chain bun run typecheck
safe-chain bun test
safe-chain bun run build
safe-chain bun run pack:verify
```

Nix dev shell は Node.js 24 と nixpkgs が提供する Bun version を固定します。`.envrc` を確認してから `direnv allow` を一度実行すると、自動で shell を読み込めます。CI は Bun 1.3.14 に pin したままです。現在の nixpkgs Bun version は少し異なる場合がありますが、`flake.lock` により local shell の再現性を保ちます。

test suite は credential-free の MCP stdio と ACP subprocess の integration coverage を含みます。`pack:verify` はさらに、pack 済みの `dist/bin/kyoso.js` MCP server を起動し、published bundle の protocol handshake を確認します。

既知の配布リスク: `@modelcontextprotocol/server` にはまだ stable release がありません。Kyoso は現在 prerelease API を pin しているため、MCP SDK API の変更に追従する follow-up release が必要になる場合があります。`@modelcontextprotocol/server`、`@agentclientprotocol/sdk`、または pin 済み ACP adapters を bump する release の前には、手動での real-agent dogfooding を実行してください。

Debug 用の environment variables:

- `KYOSO_TEST_FAKE_AGENTS=1`: test-only fake ACP agents; production では設定しないでください。
- `KYOSO_KEEP_TEMP=1`: local debugging 用に temporary snapshots を保持します。

## License

Kyoso は GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`) で licensed されています。

Kyoso は separate CLI または MCP server process として使うことを想定しています。Kyoso を他の program に embedding、importing、linking する場合、license implications が異なる可能性があります。

Copyright (C) 2026 Hokuto TAKEMIYA (hokupod).
