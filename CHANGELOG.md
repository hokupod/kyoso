# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Codex Marketplace fixture with a version-pinned local stdio MCP, bundled
  `kyoso-review` Skill, isolated runtime probe, and compatibility records for
  Codex CLI 0.144.0-alpha.4 and 0.144.1.
- `kyoso setup codex|claude-code --skill-only` for installing the canonical
  Skill without reading or writing MCP configuration. The setup surface also
  supports `--force` for Skill-only replacement and rejects MCP-only option
  combinations.
- Managed Skill updates with deterministic directory digests,
  `.kyoso-install.json`, published 0.8.0 legacy adoption, user-change conflict
  detection, symlink rejection, and staged backup/rename replacement.

### Changed

- Recover interrupted managed-Skill replacements from a fixed backup, fail
  closed on ambiguous recovery state, and guard rename operations against
  parent-directory replacement.
- Audit traces now use a verified POSIX user state root (`$XDG_STATE_HOME` or
  `$HOME/.local/state`) instead of a workspace-controlled `.kyoso/traces`
  path. The new layout hashes the workspace realpath; existing workspace
  traces are not migrated or deleted automatically.
- The canonical bundled Skill continues to try Kyoso MCP tools, an installed
  `kyoso` on `PATH`, `npx`, then `bunx`, without declaring MCP as a required
  dependency. The generated Marketplace Plugin copy declares its bundled
  `kyoso` MCP server as a dependency; a disabled Plugin MCP must be re-enabled
  or migrated to CLI plus Skill-only rather than falling back to the CLI.
- Codex MCP configuration resolves from `CODEX_HOME`, while global Codex Skill
  installation continues to resolve from `HOME`.

### Fixed

- Harden Audit trace creation against workspace-controlled symlinks and races
  with verified handles, exclusive creation, and fail-closed state-root
  containment. Windows and runtimes without proven safe filesystem
  capabilities disable Audit writing rather than using an insecure fallback;
  Windows support will be re-enabled only after equivalent ownership, symlink,
  and file-identity guarantees are implemented and verified.

## [0.8.0] - 2026-07-10

### Added

- Repeatable `--set <config-key>=<value>` option on the `plan`, `security`,
  and `diff` commands for overriding config values such as
  `agents.<agent>.model`, `agents.<agent>.effort`, and `timeoutMs` from the
  command line. Overrides are restricted to the shared project-scope
  allowlist, applied after config files (including with `--ignore-config`),
  and schema-validated.
- CLI fallback in the bundled `kyoso-review` skill: when the Kyoso MCP
  server is not registered, the skill falls back to
  `npx`/`bunx @kyo-so/cli plan|security|diff --json`. The fallback runs
  without config trust flags first and requires user confirmation before
  `--trust-config` or `--ignore-config`. Documented in all README languages.

## [0.7.1] - 2026-07-09

### Changed

- Update `@agentclientprotocol/sdk` from 1.1.0 to 1.2.0: ACP schema 1.19.0,
  linear-time `ndJsonStream` receive path, and unified JSON-RPC message
  validation across transports.

## [0.7.0] - 2026-07-09

### Added

- `agents.<name>.effort` config field for Codex and Claude, mirroring
  `agents.<name>.model`. Kyoso sends it once per session as an ACP
  `session/set_config_option` request (`effort` for Claude,
  `reasoning_effort` for Codex). The request is fail-soft: a rejection is
  logged to stderr as a sanitized warning and surfaced to MCP/JSON callers
  via `result.audit.warnings`, and the review continues at the backend's
  own default effort. Settable from both user-global and project TOML
  (same risk profile as `model`: no command execution or env forwarding).

### Fixed

- Documentation still described the default Claude agent timeout as 240
  seconds; README (all languages), the design document, and the example
  config now reflect the 300-second default introduced in 0.6.0.

## [0.6.0] - 2026-07-08

### Added

- TOML config loading with XDG user-global layering:
  `$XDG_CONFIG_HOME/kyoso/config.toml` or `~/.config/kyoso/config.toml`, then
  project `kyoso.toml`.
- Unknown-key detection for user-global `config.toml`; security-sensitive
  unknown settings fail closed by default, with `--allow-unknown-config` as an
  explicit opt-out.
- Project TOML scope validation for repository-owned settings, including
  additive `workspace.deny` and tightening-only security/network keys.
- `kyoso doctor` now reports global, project TOML, and legacy TypeScript config
  layers.

### Changed

- `kyoso init` now writes `kyoso.toml`.
- `--config` now fails when the specified file does not exist.
- Default Claude agent timeout raised from 240s to 300s; dogfooding traces
  showed frequent reviews truncated at the previous limit.
- Repository dogfooding config and examples now use TOML.

### Deprecated

- `kyoso.config.ts` remains supported through the existing trust flow, but emits
  a deprecation warning. When both `kyoso.toml` and `kyoso.config.ts` exist,
  TOML takes precedence.

## [0.5.0] - 2026-07-08

### Added

- Cross-validation classification on aggregated findings: findings backed by
  both agents are marked `corroborated`, single-agent findings `single_source`.
- Fusion-style cross-model analysis from the advisory judge: blind spots,
  semantic contradictions, and partial coverage are reported as advisory
  metadata (`crossModelAnalysis`); the deterministic decision is unchanged.
- Optional adversarial verification round (`verification.enabled`, default
  off): single-source high/critical findings are sent to the other agent with
  a skeptical refute-first prompt. Annotate-only: verdicts adjust confidence
  and notes, never severity or the decision.
- CI-ready MCP stdio and ACP subprocess integration tests now cover the real
  protocol boundaries without live LLM credentials. `pack:verify` also starts
  the packed CLI bin as an MCP server and checks its version and tool list.
- Nix development shell pinning Node.js and Bun for reproducible local setups.

### Changed

- Reviewer prompts now require concise English finding titles (evidence,
  recommendations, and summaries may stay in the user's language) and clarify
  that selected files show the pre-change base state during diff reviews.
- Same-category findings that reference overlapping line ranges in the same
  file now merge regardless of title wording, so cross-model corroboration no
  longer depends on title phrasing.

## [0.4.1] - 2026-07-07

### Changed

- Updated `@modelcontextprotocol/server` to 2.0.0-beta.2 and
  `@agentclientprotocol/sdk` to 1.1.0. Before release, the MCP stdio server
  handshake was smoke-tested against beta.2 and a full multi-agent review run
  was verified with real Codex and Claude agents on the updated ACP stack.

## [0.4.0] - 2026-07-07

### Added

- Pinned default ACP adapter versions (`@agentclientprotocol/codex-acp@1.1.0`,
  `@agentclientprotocol/claude-agent-acp@0.57.0`) so adapter updates ship
  through deliberate Kyoso releases instead of being fetched as `latest` at
  runtime. Overrides via `kyoso.config.ts` still work.
- Version consistency enforcement: `bun test` and `pack:verify` fail when the
  MCP server version constant drifts from `package.json`, and release builds
  fail when the git tag does not match the package version.
- CI and release workflows install dependencies through Aikido safe-chain,
  blocking known-malicious package versions before they execute.
- `repository`, `homepage`, and `bugs` metadata in `package.json` (required
  for provenance validation).

### Changed

- Releases are now published via npm trusted publishing (OIDC) from GitHub
  Actions with provenance attestation. Verify with `npm audit signatures`.

## [0.3.0] - 2026-07-07

### Added

- Single-agent mode: Kyoso now works when only Claude or only Codex is
  available. The remaining backend runs once as `combined_reviewer`, covering
  both implementation and architecture/security focus areas.
- `reviewMode` (`multi_agent` / `single_agent`) and `agentsUsed` in JSON
  output; Markdown output states when cross-model verification was not
  performed and marks Disagreements as N/A.
- `kyoso doctor` and `kyoso setup` suggest a single-agent config when only
  one backend command is found on PATH.
- `examples/claude-only.config.ts` and `examples/codex-only.config.ts`.

### Changed

- Agent role prompts are driven by `agents.<name>.role` in `kyoso.config.ts`
  instead of being hardcoded per agent name. Default configs behave the same;
  customized `role` values now take effect.

### Fixed

- The MCP server reports the correct package version (previously stuck at
  0.1.0).

## [0.2.0] - 2026-07-05

### Added

- `kyoso setup codex` / `kyoso setup claude-code` for one-command MCP
  registration and review-skill installation.
- Quick Start documentation and expanded `kyoso doctor` diagnostics.
- Japanese and Simplified Chinese READMEs.

## [0.1.0] - 2026-07-05

### Added

- Initial public release: MCP-native, ACP-powered multi-agent review gate
  coordinating Codex and Claude reviewers for plan review, CISA Secure by
  Design security review, and diff review.
- Deterministic decision gates, secret scanning with redaction, read-only
  temp-snapshot workspaces, and JSONL audit traces.
