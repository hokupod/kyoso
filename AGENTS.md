# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript implementation. Main areas are `core/` for review orchestration, `cli/` for command entry points, `mcp/` for MCP tools, `acp/` for backend agent clients, plus `config/`, `context/`, `workspace/`, `security/`, `audit/`, `aggregate/`, `output/`, and `utils/`.
- `test/` is split into `unit/`, `integration/`, `e2e/`, and `fixtures/`.
- `examples/` holds sample MCP and `kyoso.config.ts` configuration.
- `docs/kyoso_detailed_design.md` is the product and architecture source of truth when behavior is ambiguous.
- `.agents/skills/kyoso-review/` contains the packaged Codex skill. `.kyoso/`, `dist/`, and `node_modules/` are generated or local-only paths.

## Build, Test, and Development Commands

- `safe-chain bun install`: install dependencies from `bun.lock`.
- `safe-chain bun run dev -- <args>`: run the CLI from `src/cli/main.ts`.
- `safe-chain bun run typecheck`: run strict TypeScript checks with no emit.
- `safe-chain bun test`: run Bun unit, integration, and e2e tests.
- `safe-chain bun run build`: build the library, CLI binary, and declaration files into `dist/`.
- `safe-chain bun run format`: format the repository with Prettier.

## Coding Style & Naming Conventions

- Use TypeScript ES modules with explicit `.js` import suffixes for local runtime imports.
- Keep strict typing compatible with `strict` and `noUncheckedIndexedAccess`.
- Prefer named exports and descriptive camelCase function names; reserve PascalCase for types, classes, and schemas.
- Follow the existing two-space indentation and Prettier formatting.

## Testing Guidelines

- Tests use `bun:test`; name files `*.test.ts` under the matching `test/` tier.
- Add unit coverage for pure policy, parsing, aggregation, and validation logic.
- Add integration or e2e coverage when touching `runReview`, ACP process handling, CLI behavior, snapshots, or MCP responses.
- Keep fixtures in `test/fixtures/` and avoid real provider credentials.

## Commit & Pull Request Guidelines

- Use Conventional Commits, matching the current history, for example `feat: implement kyoso mvp` or `fix: block recursive kyoso calls`.
- PRs should include a short behavior summary, linked issue or design reference, and the commands run.
- Include CLI output or screenshots only when user-facing behavior changes.
- Call out changes to security policy, network mode, audit traces, or config execution risk.

## Security & Agent-Specific Notes

- Do not commit `.kyoso/` traces, secrets, dependency folders, or build output.
- Treat `kyoso.config.ts` as executable code; use `--ignore-config` for untrusted repositories.
- Invoke the `kyoso-review` skill only for explicit multi-agent plan, security, CISA, or diff review requests. Kyoso reviews only; it must not apply code changes.
