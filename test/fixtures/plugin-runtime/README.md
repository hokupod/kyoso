# Plugin runtime fixture

`scripts/plugin-runtime-probe.mjs` copies the tracked Marketplace template from `.agents/plugins/marketplace.json` and `plugins/kyoso/` into a temporary root. It replaces only the temporary `.mcp.json` command with `probe-server.mjs`, then runs Codex with distinct temporary `HOME`, `CODEX_HOME`, and workspace directories.

The tracked Plugin remains pinned to an exact published Kyoso CLI version. Probe observations contain only synthetic credentials and are normalized before comparison with `docs/compatibility/codex-plugin-runtime.json`.

`safe-chain bun run plugin:runtime:verify` replays every Codex version recorded
in that compatibility file and rejects any contract drift. Use
`safe-chain bun run plugin:verify` before it to validate the tracked catalog,
manifest, MCP map, canonical Skill mirror, bundled runtime contract, and npm
tarball exclusion rules.

After a CLI version has been published, preview the separate Plugin promotion
with `safe-chain bun run plugin:promote -- --cli-version <CLI_VERSION>
--plugin-version <PLUGIN_VERSION>`. It is dry-run by default and requires
`--write` to update the MCP pin, Plugin SemVer, compatibility record, and
bundled runtime contract. Use it only after a newer CLI version is published
and a separate Plugin promotion change is intended.
