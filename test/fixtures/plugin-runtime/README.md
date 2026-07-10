# Plugin runtime fixture

`scripts/plugin-runtime-probe.mjs` copies the tracked Marketplace template from `.agents/plugins/marketplace.json` and `plugins/kyoso/` into a temporary root. It replaces only the temporary `.mcp.json` command with `probe-server.mjs`, then runs Codex with distinct temporary `HOME`, `CODEX_HOME`, and workspace directories.

The tracked Plugin remains pinned to the published `@kyo-so/cli@0.8.0`. Probe observations contain only synthetic credentials and are normalized before comparison with `docs/compatibility/codex-plugin-runtime.json`.
