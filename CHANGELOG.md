# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
