import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCodexMcpToml,
  buildClaudeMcpEntry,
  commandForRunner,
  detectSetup,
  runSetup,
  skillDestination,
} from "../../src/cli/setup.js";

describe("setup", () => {
  test("builds npx and bunx MCP commands", () => {
    expect(commandForRunner("npx")).toEqual({
      command: "npx",
      args: ["-y", "@kyo-so/cli", "mcp"],
    });
    expect(commandForRunner("bunx")).toEqual({
      command: "bunx",
      args: ["@kyo-so/cli", "mcp"],
    });
  });

  test("renders dry-run output without writing files", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-dry-");
    const output = await runSetup({
      cwd,
      client: "codex",
      write: false,
      global: false,
      env: { HOME: home },
    });

    expect(output).toContain("Codex MCP: dry-run");
    expect(output).toContain("[mcp_servers.kyoso]");
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(skillDestination("codex", "project", cwd, home))).toBe(
      false,
    );
  });

  test("writes Codex MCP and skill idempotently", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-codex-");
    const first = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      env: { HOME: home },
    });
    const second = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      env: { HOME: home },
    });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");

    expect(first).toContain("Codex MCP: created");
    expect(second).toContain("Codex MCP: skipped");
    expect(second).toContain("Codex skill: skipped");
    expect(config.match(/\[mcp_servers\.kyoso]/g)).toHaveLength(1);
    expect(
      existsSync(
        join(skillDestination("codex", "project", cwd, home), "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("merges Claude Code project MCP without removing existing servers", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-claude-");
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            existing: { command: "node", args: ["server.js"] },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const first = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home },
    });
    const second = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home },
    });
    const parsed = JSON.parse(
      await readFile(join(cwd, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(first).toContain("Claude Code MCP: updated");
    expect(second).toContain("Claude Code MCP: skipped");
    expect(Object.keys(parsed.mcpServers).sort()).toEqual([
      "existing",
      "kyoso",
    ]);
    expect(parsed.mcpServers.kyoso).toMatchObject({
      command: "bunx",
      args: ["@kyo-so/cli", "mcp"],
    });
    expect(
      existsSync(
        join(skillDestination("claude-code", "project", cwd, home), "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("keeps existing setup entries", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-skip-");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      buildCodexMcpToml(commandForRunner("npx")),
      "utf8",
    );
    const skillDir = skillDestination("codex", "global", cwd, home);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "existing", "utf8");

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: true,
      env: { HOME: home },
    });

    expect(output).toContain("Codex MCP: skipped");
    expect(output).toContain("Codex skill: skipped");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("existing");
  });

  test("detects quoted Codex MCP table and nested Claude MCP config", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-detect-");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      '[mcp_servers."kyoso"]\ncommand = "npx"\n',
      "utf8",
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [cwd]: {
            mcpServers: {
              kyoso: { command: "npx" },
            },
          },
        },
      }),
      "utf8",
    );

    const detected = detectSetup({ cwd, home });

    expect(detected.codex.mcp).toBe(true);
    expect(detected["claude-code"].mcp).toBe(true);
  });

  test("builds Claude MCP entry with provider env placeholders", () => {
    expect(buildClaudeMcpEntry(commandForRunner("npx"))).toMatchObject({
      command: "npx",
      args: ["-y", "@kyo-so/cli", "mcp"],
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}",
      },
    });
  });

  test("suggests Claude-only config when codex is unavailable", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-single-agent-");
    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: false,
      global: false,
      env: { HOME: home, PATH: cwd },
    });

    expect(output).toContain("Single-agent config: skipped");
    expect(output).toContain("codex was not found on PATH");
    expect(output).toContain("codex: { enabled: false }");
    expect(output).toContain("combined_reviewer");
  });
});

async function setupTempDirs(prefix: string): Promise<{
  cwd: string;
  home: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const cwd = join(root, "repo");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  return { cwd, home };
}
