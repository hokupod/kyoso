import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CURRENT_SKILL_DIGEST } from "../../src/cli/knownSkillDigests.js";
import { KYOSO_VERSION } from "../../src/core/constants.js";
import {
  buildCodexMcpToml,
  buildClaudeMcpEntry,
  commandForRunner,
  detectCodexPluginMcpOverride,
  detectSetup,
  resolveCodexConfigPath,
  resolveCodexUserSkillPath,
  runSetup,
  skillDestination,
} from "../../src/cli/setup.js";
import {
  ensureManagedSkill,
  hashSkillDirectory,
  SKILL_INSTALL_BACKUP,
  SKILL_INSTALL_MARKER,
  SKILL_INSTALL_TRANSACTION,
} from "../../src/cli/skillInstall.js";

const historicalSkillDir = resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "skill-v0.8.0",
);
const verifiedBunxVersion = () => ({
  status: "verified" as const,
  version: "1.3.14",
});

describe("setup", () => {
  test("builds npx and bunx MCP commands", () => {
    expect(commandForRunner("npx")).toEqual({
      command: "npx",
      args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
    });
    expect(commandForRunner("bunx")).toEqual({
      command: "bunx",
      args: ["--package", "@kyo-so/cli", "kyoso", "mcp"],
    });
  });

  test("omits OpenRouter from the default Codex MCP env allowlist", () => {
    const envLine = buildCodexMcpToml(commandForRunner("npx"))
      .split("\n")
      .find((line) => line.startsWith("env_vars = "));

    expect(envLine).toBe(
      'env_vars = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "CODEX_ACCESS_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]',
    );
  });

  test("adds OpenRouter to the Codex MCP env allowlist only when requested", () => {
    const envLine = buildCodexMcpToml(commandForRunner("npx"), true)
      .split("\n")
      .find((line) => line.startsWith("env_vars = "));

    expect(envLine).toBe(
      'env_vars = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "CODEX_ACCESS_TOKEN", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]',
    );
  });

  test("allows the MCP client to outlive a 35-minute review", () => {
    expect(buildCodexMcpToml(commandForRunner("npx"))).toContain(
      "tool_timeout_sec = 2160",
    );
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
    expect(output).toContain("Credential scope");
    expect(output).toContain(
      "Newly generated and dry-run MCP registrations omit OPENROUTER_API_KEY",
    );
    expect(output).toContain(
      "Use --with-openrouter before writing a new registration to include it.",
    );
    expect(output).toContain(
      "Newly generated and dry-run Codex MCP registrations intentionally forward CODEX_ACCESS_TOKEN for default Codex authentication; OpenRouter mode withholds it from the Codex child.",
    );
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(skillDestination("codex", "project", cwd, home))).toBe(
      false,
    );
  });

  test("writes the Codex OpenRouter allowlist only when requested", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-openrouter-");
    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      withOpenRouter: true,
      env: { HOME: home },
    });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");

    expect(output).toContain(
      "include OPENROUTER_API_KEY because --with-openrouter was set.",
    );
    expect(config).toContain("OPENROUTER_API_KEY");
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
      withOpenRouter: true,
      env: { HOME: home },
    });
    const config = await readFile(join(home, ".codex", "config.toml"), "utf8");

    expect(first).toContain("Codex MCP: created");
    expect(second).toContain("Codex MCP: skipped");
    expect(second).toContain("Codex skill: skipped");
    expect(second).toContain(
      "Existing MCP registrations were preserved unchanged; --with-openrouter does not edit them.",
    );
    expect(second).not.toContain(
      "Newly generated and dry-run MCP registrations omit OPENROUTER_API_KEY",
    );
    expect(config).not.toContain("OPENROUTER_API_KEY");
    expect(config.match(/\[mcp_servers\.kyoso]/g)).toHaveLength(1);
    expect(
      existsSync(
        join(skillDestination("codex", "project", cwd, home), "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          join(
            skillDestination("codex", "project", cwd, home),
            SKILL_INSTALL_MARKER,
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      installer: "@kyo-so/cli",
      cliVersion: KYOSO_VERSION,
      digest: CURRENT_SKILL_DIGEST,
    });
  });

  test("keeps disabled manual MCP entries and explains how to re-enable them", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-disabled-mcp-");
    const codexHome = join(cwd, "codex-state");
    const codexConfigPath = join(codexHome, "config.toml");
    const claudeProjectConfigPath = join(cwd, ".mcp.json");
    const claudeGlobalConfigPath = join(home, ".claude.json");
    const env = { HOME: home, CODEX_HOME: codexHome };
    const codexConfig = [
      "[mcp_servers.kyoso]",
      'command = "npx"',
      "enabled = false",
      "",
    ].join("\n");
    const claudeProjectConfig = `${JSON.stringify(
      { mcpServers: { kyoso: { command: "npx", enabled: false } } },
      null,
      2,
    )}\n`;
    const claudeGlobalConfig = `${JSON.stringify(
      { mcpServers: { kyoso: { command: "npx", enabled: false } } },
      null,
      2,
    )}\n`;

    await mkdir(codexHome, { recursive: true });
    await writeFile(codexConfigPath, codexConfig, "utf8");
    await writeFile(claudeProjectConfigPath, claudeProjectConfig, "utf8");
    await writeFile(claudeGlobalConfigPath, claudeGlobalConfig, "utf8");

    const codexOutput = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      env,
    });
    const claudeProjectOutput = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      env,
    });
    const claudeGlobalOutput = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: true,
      env,
    });

    expect(codexOutput).toContain("Codex MCP: skipped");
    expect(codexOutput).toContain(codexConfigPath);
    expect(codexOutput).toContain("is disabled and was kept unchanged");
    expect(codexOutput).toContain("enabled = false to enabled = true");
    expect(await readFile(codexConfigPath, "utf8")).toBe(codexConfig);

    expect(claudeProjectOutput).toContain("Claude Code MCP: skipped");
    expect(claudeProjectOutput).toContain(claudeProjectConfigPath);
    expect(claudeProjectOutput).toContain("is disabled and was kept unchanged");
    expect(claudeProjectOutput).toContain(
      '\"enabled\": false to \"enabled\": true',
    );
    expect(await readFile(claudeProjectConfigPath, "utf8")).toBe(
      claudeProjectConfig,
    );

    expect(claudeGlobalOutput).toContain("Claude Code MCP: skipped");
    expect(claudeGlobalOutput).toContain(claudeGlobalConfigPath);
    expect(claudeGlobalOutput).toContain("is disabled and was kept unchanged");
    expect(claudeGlobalOutput).toContain(
      '\"enabled\": false to \"enabled\": true',
    );
    expect(await readFile(claudeGlobalConfigPath, "utf8")).toBe(
      claudeGlobalConfig,
    );
  });

  test("shows a legacy Codex migration in dry-run, preserves it without force, and migrates it with force", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-legacy-codex-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    const legacy = [
      "[mcp_servers.kyoso]",
      'command = "npx"',
      'args = ["-y", "@kyo-so/cli@0.13.1", "mcp"] # retain comment',
      "enabled = false",
      "startup_timeout_sec = 20",
      'api_key = "codex-preview-secret-value"',
      "",
      "[mcp_servers.other]",
      'command = "node"',
      "",
    ].join("\n");
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, legacy, "utf8");
    const options = {
      cwd,
      client: "codex" as const,
      global: false,
      env: { HOME: home, CODEX_HOME: codexHome },
    };

    const dryRun = await runSetup({ ...options, write: false });
    expect(dryRun).toContain("Codex MCP: dry-run");
    expect(dryRun).toContain("--package=@kyo-so/cli@0.13.1");
    expect(dryRun).not.toContain("codex-preview-secret-value");
    expect(dryRun).not.toContain("[mcp_servers.other]");
    expect(await readFile(configPath, "utf8")).toBe(legacy);

    const preserved = await runSetup({ ...options, write: true });
    expect(preserved).toContain("Codex MCP: skipped");
    expect(await readFile(configPath, "utf8")).toBe(legacy);

    const migrated = await runSetup({ ...options, write: true, force: true });
    const updated = await readFile(configPath, "utf8");
    expect(migrated).toContain("Codex MCP: updated");
    expect(updated).toContain(
      'args = ["-y","--package=@kyo-so/cli@0.13.1","kyoso","mcp"] # retain comment',
    );
    expect(updated).toContain("enabled = false");
    expect(updated).toContain('[mcp_servers.other]\ncommand = "node"');
  });

  test("migrates only exact Claude project legacy registrations", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-legacy-claude-");
    const configPath = join(cwd, ".mcp.json");
    const legacy = {
      mcpServers: {
        kyoso: {
          command: "bunx",
          args: ["@kyo-so/cli@0.13.1", "mcp"],
          enabled: false,
          timeout: 42,
          env: { OPENAI_API_KEY: "${OPENAI_API_KEY}" },
          token: "claude-preview-secret-value",
        },
        other: { command: "node", args: ["server.js"] },
      },
    };
    await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    const dryRun = await runSetup({
      cwd,
      client: "claude-code",
      write: false,
      global: false,
      force: true,
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    expect(dryRun).toContain("Claude Code MCP: dry-run");
    expect(dryRun).toContain('args = ["@kyo-so/cli@0.13.1", "mcp"]');
    expect(dryRun).toContain(
      'args = ["--package", "@kyo-so/cli@0.13.1", "kyoso", "mcp"]',
    );
    expect(dryRun).not.toContain("claude-preview-secret-value");

    const beforeImplicitBunxMigration = await readFile(configPath, "utf8");
    let implicitBunxProbeCalls = 0;
    const implicitBunxMigration = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      bunxVersionProbe: () => {
        implicitBunxProbeCalls += 1;
        return verifiedBunxVersion();
      },
    });
    expect(implicitBunxMigration).toContain("Claude Code MCP: skipped");
    expect(implicitBunxMigration).toContain("--runner bunx --force");
    expect(implicitBunxProbeCalls).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(
      beforeImplicitBunxMigration,
    );

    const beforeBlockedMigration = await readFile(configPath, "utf8");
    const blocked = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: () => ({
        status: "unsupported",
        detail: "bunx 1.2.15 is older than the verified minimum 1.3.14",
      }),
    });
    expect(blocked).toContain("Claude Code MCP: skipped");
    expect(blocked).toContain("No MCP config was written");
    expect(await readFile(configPath, "utf8")).toBe(beforeBlockedMigration);

    const migrated = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    const updated = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as typeof legacy;
    expect(migrated).toContain("Claude Code MCP: updated");
    expect(updated.mcpServers.kyoso).toMatchObject({
      command: "bunx",
      args: ["--package", "@kyo-so/cli@0.13.1", "kyoso", "mcp"],
      enabled: false,
      timeout: 42,
      env: { OPENAI_API_KEY: "${OPENAI_API_KEY}" },
    });
    expect(updated.mcpServers.other).toEqual(legacy.mcpServers.other);

    const custom = `${JSON.stringify({
      mcpServers: {
        kyoso: { command: "npx", args: ["-y", "@kyo-so/cli@latest", "mcp"] },
      },
    })}\n`;
    await writeFile(configPath, custom, "utf8");
    const preserved = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
    });
    expect(preserved).toContain("Claude Code MCP: skipped");
    expect(await readFile(configPath, "utf8")).toBe(custom);
  });

  test("does not migrate a legacy Claude registration with an unsafe environment", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-unsafe-legacy-claude-",
    );
    const configPath = join(cwd, ".mcp.json");
    const legacy =
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","@kyo-so/cli","mcp"],"env":{"NODE_OPTIONS":"--require /tmp/payload.js"}}}}\n';
    await writeFile(configPath, legacy, "utf8");

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
    });

    expect(output).toContain("Claude Code MCP: skipped");
    expect(output).toContain("custom/unverified");
    expect(await readFile(configPath, "utf8")).toBe(legacy);
  });

  test("does not probe bunx for setup dry-runs or non-forced legacy writes", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-dry-run-");
    const configPath = join(cwd, ".mcp.json");
    const legacy = JSON.stringify({
      mcpServers: {
        kyoso: { command: "bunx", args: ["@kyo-so/cli", "mcp"] },
      },
    });
    await writeFile(configPath, legacy, "utf8");
    let probeCalls = 0;
    const probe = () => {
      probeCalls += 1;
      return verifiedBunxVersion();
    };

    const dryRun = await runSetup({
      cwd,
      client: "claude-code",
      write: false,
      global: false,
      force: true,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: probe,
    });
    const preserved = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: false,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: probe,
    });
    const generatedDryRun = await runSetup({
      cwd,
      client: "codex",
      write: false,
      global: false,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: probe,
    });

    expect(probeCalls).toBe(0);
    expect(dryRun).toContain(
      "will be verified before any MCP config is written",
    );
    expect(preserved).toContain("Legacy registration was kept");
    expect(generatedDryRun).toContain(
      "will be verified before any MCP config is written",
    );
    expect(await readFile(configPath, "utf8")).toBe(legacy);
  });

  test("losslessly patches only the legacy Claude MCP command and args", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-lossless-json-");
    const configPath = join(cwd, ".mcp.json");
    const legacy = [
      "{",
      '  "metadata": { "highPrecision": 9007199254740993 },',
      '  "mcpServers": {',
      '    "kyoso": {',
      '      "command": "bunx",',
      '      "args": ["@kyo-so/cli", "mcp"],',
      '      "keep": "format"',
      "    },",
      '    "other": { "highPrecision": 9007199254740993 }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(configPath, legacy, "utf8");

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    const updated = await readFile(configPath, "utf8");

    expect(output).toContain("Claude Code MCP: updated");
    expect(updated).toContain(
      '  "metadata": { "highPrecision": 9007199254740993 },',
    );
    expect(updated).toContain(
      '    "other": { "highPrecision": 9007199254740993 }',
    );
    expect(updated).toContain('      "keep": "format"');
    expect(updated).toContain(
      '      "args": ["--package","@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test("does not overwrite a Claude config changed just before migration commit", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-claude-commit-");
    const configPath = join(cwd, ".mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      beforeManualMcpCommit: async () => {
        await writeFile(
          configPath,
          '{"mcpServers":{"kyoso":{"command":"node","args":["other.js"]}}}\n',
          "utf8",
        );
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe(
      '{"mcpServers":{"kyoso":{"command":"node","args":["other.js"]}}}\n',
    );
  });

  test("does not overwrite a Claude config changed after final migration validation", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-final-validation-",
    );
    const configPath = join(cwd, ".mcp.json");
    const lateWriterContents =
      '{"mcpServers":{"kyoso":{"command":"node","args":["other.js"]}}}\n';
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      afterManualMcpValidation: async () => {
        await writeFile(configPath, lateWriterContents, "utf8");
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe(lateWriterContents);
  });

  test("preserves a symlink swapped after final migration validation", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-symlink-validation-",
    );
    const configPath = join(cwd, ".mcp.json");
    const targetPath = join(cwd, "concurrent-config.json");
    await writeFile(targetPath, '{"concurrent":true}\n', "utf8");
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      afterManualMcpValidation: async () => {
        await rm(configPath);
        await symlink(targetPath, configPath);
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true);
  });

  test("does not overwrite a config changed before atomic replacement", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-rename-race-",
    );
    const configPath = join(cwd, ".mcp.json");
    const concurrentContents =
      '{"mcpServers":{"kyoso":{"command":"node","args":["other.js"]}}}\n';
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      beforeManualMcpRename: async () => {
        await rm(configPath);
        await writeFile(configPath, concurrentContents, "utf8");
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe(concurrentContents);
  });

  test("keeps the legacy config addressable until atomic replacement", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-atomic-replacement-",
    );
    const configPath = join(cwd, ".mcp.json");
    const original =
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n';
    await writeFile(configPath, original, "utf8");

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      manualMcpRename: async (source, destination) => {
        expect(await readFile(destination, "utf8")).toBe(original);
        await rename(source, destination);
      },
    });

    expect(output).toContain("Claude Code MCP: updated");
    expect(await readFile(configPath, "utf8")).toContain(
      '"args":["-y","--package=@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test("preserves the original config when atomic replacement fails", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-install-failure-",
    );
    const configPath = join(cwd, ".mcp.json");
    const original = [
      "{",
      '  "mcpServers": {',
      '    "kyoso": { "command": "npx", "args": ["@kyo-so/cli", "mcp"] },',
      '    "other": { "command": "node", "args": ["other.js"] }',
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      manualMcpRename: async () => {
        throw new Error("injected manual MCP rename failure");
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(
      (await readdir(cwd)).some(
        (name) => name.includes(".kyoso-") && name.endsWith(".tmp"),
      ),
    ).toBe(false);
  });

  test("reports an uncertain result when replacement fails after committing", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-post-commit-failure-",
    );
    const configPath = join(cwd, ".mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      manualMcpRename: async (source, destination) => {
        await rename(source, destination);
        throw new Error("injected post-commit failure");
      },
    });

    expect(output).toContain("Claude Code MCP: conflict");
    expect(output).toContain("may have been committed");
    expect(await readFile(configPath, "utf8")).toContain(
      '"args":["-y","--package=@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test("migrates a quoted Codex MCP table", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-quoted-codex-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      '[mcp_servers."kyoso"]\ncommand = "npx"\nargs = ["@kyo-so/cli", "mcp"]\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });

    expect(output).toContain("Codex MCP: updated");
    expect(await readFile(configPath, "utf8")).toContain(
      'args = ["-y","--package=@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test("preserves bracketed trailing comments while migrating Codex args", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-codex-trailing-comment-",
    );
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      [
        "[mcp_servers.kyoso]",
        'command = "npx"',
        'args = ["-y", "@kyo-so/cli", "mcp"] # keep [ticket-123]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });

    expect(output).toContain("Codex MCP: updated");
    expect(await readFile(configPath, "utf8")).toContain(
      'args = ["-y","--package=@kyo-so/cli","kyoso","mcp"] # keep [ticket-123]',
    );
    expect(await readFile(configPath, "utf8")).toContain("enabled = true");
  });

  test.each([
    [
      "dotted keys",
      [
        'mcp_servers.kyoso.command = "npx"',
        'mcp_servers.kyoso.args = ["-y", "@kyo-so/cli", "mcp"]',
        "",
      ].join("\n"),
    ],
    [
      "an inline table",
      [
        "[mcp_servers]",
        'kyoso = { command = "npx", args = ["-y", "@kyo-so/cli", "mcp"] }',
        "",
      ].join("\n"),
    ],
    [
      "an inline mcp_servers assignment",
      'mcp_servers = { other = { command = "node" } }\n',
    ],
  ] as const)(
    "does not append a Codex registration over %s",
    async (_shape, original) => {
      const { cwd, home } = await setupTempDirs(
        "kyoso-setup-codex-unextendable-",
      );
      const codexHome = join(cwd, "codex-state");
      const configPath = join(codexHome, "config.toml");
      await mkdir(codexHome, { recursive: true });
      await writeFile(configPath, original, "utf8");

      const output = await runSetup({
        cwd,
        client: "codex",
        write: true,
        global: false,
        env: { HOME: home, CODEX_HOME: codexHome },
      });

      expect(output).toContain("Codex MCP: conflict");
      expect(await readFile(configPath, "utf8")).toBe(original);
    },
  );

  test("switches a legacy Codex MCP runner while migrating", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-codex-runner-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      [
        "[mcp_servers.kyoso]",
        'command = "bunx"',
        'args = ["@kyo-so/cli@0.13.1", "mcp"]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      runner: "npx",
      env: { HOME: home, CODEX_HOME: codexHome },
    });
    const updated = await readFile(configPath, "utf8");

    expect(output).toContain("Codex MCP: updated");
    expect(updated).toContain('command = "npx"');
    expect(updated).toContain(
      'args = ["-y","--package=@kyo-so/cli@0.13.1","kyoso","mcp"]',
    );
    expect(updated).toContain("enabled = true");
  });

  test("provides an npx fallback that can migrate a legacy bunx registration", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-fallback-");
    const configPath = join(cwd, ".mcp.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"bunx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const blocked = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
      bunxVersionProbe: () => ({
        status: "unsupported",
        detail: "bunx 1.2.15 is older than the verified minimum 1.3.14",
      }),
    });
    const recovered = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      runner: "npx",
      env: { HOME: home },
    });

    expect(blocked).toContain("--runner npx --force");
    expect(recovered).toContain("Claude Code MCP: updated");
    expect(await readFile(configPath, "utf8")).toContain('"command":"npx"');
    expect(await readFile(configPath, "utf8")).toContain(
      '"args":["-y","--package=@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test("does not overwrite a legacy config changed after inspection", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-mcp-concurrent-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      '[mcp_servers.kyoso]\ncommand = "npx"\nargs = ["@kyo-so/cli", "mcp"]\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      env: { HOME: home, CODEX_HOME: codexHome },
      beforeManualMcpWrite: async () => {
        await writeFile(configPath, "changed by another writer\n", "utf8");
      },
    });
    expect(output).toContain("Codex MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe(
      "changed by another writer\n",
    );
  });

  test("does not modify malformed or linked manual MCP configs", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-mcp-safe-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, "not valid toml [[", "utf8");
    const malformed = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      env: { HOME: home, CODEX_HOME: codexHome },
    });
    expect(malformed).toContain("Codex MCP: conflict");
    expect(await readFile(configPath, "utf8")).toBe("not valid toml [[");

    const outside = join(cwd, "outside.toml");
    await writeFile(
      outside,
      '[mcp_servers.kyoso]\ncommand = "npx"\nargs = ["@kyo-so/cli", "mcp"]\n',
      "utf8",
    );
    await rm(configPath);
    await symlink(outside, configPath);
    const linked = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });
    expect(linked).toContain("Codex MCP: skipped");
    expect(await readFile(outside, "utf8")).toContain(
      'args = ["@kyo-so/cli", "mcp"]',
    );

    await rm(configPath);
    await link(outside, configPath);
    const hardLinked = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      force: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });
    expect(hardLinked).toContain("Codex MCP: skipped");
    expect((await lstat(outside)).nlink).toBe(2);
    expect(await readFile(outside, "utf8")).toContain(
      'args = ["@kyo-so/cli", "mcp"]',
    );
  });

  test("requires an explicit verified Bun capability probe before writing a bunx registration", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-probe-");
    const configPath = join(home, ".codex", "config.toml");
    const blocked = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: () => ({
        status: "unsupported",
        detail: "bunx 1.2.15 is older than the verified minimum 1.3.14",
      }),
    });
    expect(blocked).toContain("Codex MCP: skipped");
    expect(blocked).toContain("No MCP config was written");
    expect(existsSync(configPath)).toBe(false);

    const verified = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    expect(verified).toContain("Codex MCP: created");
    expect(await readFile(configPath, "utf8")).toContain(
      'args = ["--package","@kyo-so/cli","kyoso","mcp"]',
    );
  });

  test.each(["codex", "claude-code"] as const)(
    "does not overwrite a %s config changed during bunx verification",
    async (client) => {
      const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-concurrent-");
      const codexHome = join(cwd, "codex-state");
      const configPath =
        client === "codex"
          ? join(codexHome, "config.toml")
          : join(cwd, ".mcp.json");
      const original =
        client === "codex"
          ? 'existing = "original"\n'
          : '{"mcpServers":{"other":{"command":"node"}}}\n';
      const concurrent =
        client === "codex"
          ? 'existing = "changed by another writer"'
          : '{"mcpServers":{"other":{"command":"new-node"}}}';
      const bin = join(home, "bin");
      const invocationPath = join(home, "bunx-invocation");
      await mkdir(dirname(configPath), { recursive: true });
      await mkdir(bin, { recursive: true });
      await writeFile(configPath, original, "utf8");
      await writeBunxProbeScript(
        join(bin, "bunx"),
        invocationPath,
        [
          `printf '%s' ${JSON.stringify(concurrent)} > ${JSON.stringify(configPath)}`,
          "printf '%s\\n' '1.3.14'",
        ].join("\n"),
      );

      const output = await runSetup({
        cwd,
        client,
        write: true,
        global: false,
        runner: "bunx",
        env: { HOME: home, CODEX_HOME: codexHome, PATH: bin },
      });

      expect(output).toContain(
        `${client === "codex" ? "Codex" : "Claude Code"} MCP: conflict`,
      );
      expect(output).toContain("changed while bunx verification");
      expect(await readFile(configPath, "utf8")).toBe(concurrent);
    },
  );

  test.each(["1.3.14", "1.4.0"])(
    "accepts verified Bun %s through the bounded version probe",
    async (version) => {
      const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-version-");
      const bin = join(home, "bin");
      const invocationPath = join(home, "bunx-invocation");
      await mkdir(bin, { recursive: true });
      await writeBunxProbeScript(
        join(bin, "bunx"),
        invocationPath,
        `printf '%s\\n' ${JSON.stringify(version)}`,
      );

      const output = await runSetup({
        cwd,
        client: "codex",
        write: true,
        global: false,
        runner: "bunx",
        env: { HOME: home, PATH: bin },
      });

      expect(output).toContain("Codex MCP: created");
      expect(await readFile(invocationPath, "utf8")).toBe("--version\n");
    },
  );

  test.each([
    ["old", "printf '%s\\n' '1.2.15'"],
    ["pre-release", "printf '%s\\n' '1.3.14-alpha.1'"],
    ["malformed", "printf '%s\\n' 'not-a-version'"],
    ["non-zero", "printf '%s\\n' '1.3.14'\nexit 12"],
    ["timeout", "/bin/sleep 3"],
  ] as const)(
    "does not write a bunx registration when the version probe is %s",
    async (_label, body) => {
      const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-fail-");
      const bin = join(home, "bin");
      const invocationPath = join(home, "bunx-invocation");
      const configPath = join(home, ".codex", "config.toml");
      await mkdir(bin, { recursive: true });
      await writeBunxProbeScript(join(bin, "bunx"), invocationPath, body);

      const output = await runSetup({
        cwd,
        client: "codex",
        write: true,
        global: false,
        runner: "bunx",
        env: { HOME: home, PATH: bin },
      });

      expect(output).toContain("Codex MCP: skipped");
      expect(output).toContain("No MCP config was written");
      expect(await readFile(invocationPath, "utf8")).toBe("--version\n");
      expect(existsSync(configPath)).toBe(false);
    },
  );

  test("does not write a bunx registration when bunx is missing", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-missing-");
    const emptyBin = join(home, "empty-bin");
    const configPath = join(home, ".codex", "config.toml");
    await mkdir(emptyBin, { recursive: true });

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home, PATH: emptyBin },
    });

    expect(output).toContain("Codex MCP: skipped");
    expect(output).toContain("bunx was not found on PATH");
    expect(existsSync(configPath)).toBe(false);
  });

  test("does not probe bunx while rendering the setup overview", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-bunx-overview-");
    const bin = join(home, "bin");
    const invocationPath = join(home, "bunx-invocation");
    await mkdir(bin, { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      buildCodexMcpToml(commandForRunner("bunx")),
      "utf8",
    );
    await writeBunxProbeScript(
      join(bin, "bunx"),
      invocationPath,
      "printf '%s\\n' '1.3.14'",
    );

    const output = await runSetup({
      cwd,
      write: false,
      global: false,
      runner: "bunx",
      env: { HOME: home, PATH: bin },
    });

    expect(output).toContain("Kyoso setup");
    expect(output).toContain("codex: MCP bunx unverified");
    expect(existsSync(invocationPath)).toBe(false);
  });

  test("reports legacy manual MCP registrations in the setup overview", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-legacy-overview-");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      '[mcp_servers.kyoso]\ncommand = "npx"\nargs = ["-y", "@kyo-so/cli", "mcp"]\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      write: false,
      global: false,
      env: { HOME: home },
    });

    expect(output).toContain("codex: MCP repair required (legacy)");
  });

  test("explains manual migration for a global Claude legacy registration", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-global-legacy-",
    );
    const configPath = join(home, ".claude.json");
    await writeFile(
      configPath,
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: false,
      global: true,
      env: { HOME: home },
    });

    expect(output).toContain("Claude Code MCP: skipped");
    expect(output).toContain(
      "Automatic migration supports only a project .mcp.json",
    );
    expect(output).toContain(configPath);
  });

  test("fails closed when project and user Claude MCP scopes overlap", async () => {
    const { cwd, home } = await setupTempDirs(
      "kyoso-setup-claude-overlapping-scopes-",
    );
    const projectPath = join(cwd, ".mcp.json");
    const userPath = join(home, ".claude.json");
    const projectLegacy =
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","@kyo-so/cli","mcp"]}}}\n';
    const userCurrent =
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","--package=@kyo-so/cli","kyoso","mcp"]}}}\n';
    await writeFile(projectPath, projectLegacy, "utf8");
    await writeFile(userPath, userCurrent, "utf8");

    const detected = detectSetup({ cwd, home });
    expect(detected["claude-code"].mcp).toBe(false);
    expect(detected["claude-code"].manualMcpStatus).toBe("unknown");
    expect(detected["claude-code"].mcpPaths).toEqual([projectPath, userPath]);

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      force: true,
      env: { HOME: home },
    });

    expect(output).toContain("Claude Code MCP: skipped");
    expect(output).toContain("does not infer effective precedence");
    expect(output).toContain(userPath);
    expect(await readFile(projectPath, "utf8")).toBe(projectLegacy);
    expect(await readFile(userPath, "utf8")).toBe(userCurrent);
  });

  test("blocks global Claude bunx setup before invoking Claude when Bun is unverified", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-global-bunx-");
    const configPath = join(home, ".claude.json");

    const output = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: true,
      runner: "bunx",
      withOpenRouter: true,
      env: { HOME: home, PATH: "" },
      bunxVersionProbe: () => ({
        status: "unsupported",
        detail: "bunx 1.2.15 is older than the verified minimum 1.3.14",
      }),
    });

    expect(output).toContain("Claude Code MCP: skipped");
    expect(output).toContain("No MCP config was written");
    expect(output).toContain("--runner npx --global --with-openrouter");
    expect(existsSync(configPath)).toBe(false);
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
      withOpenRouter: true,
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    const second = await runSetup({
      cwd,
      client: "claude-code",
      write: true,
      global: false,
      runner: "bunx",
      env: { HOME: home },
      bunxVersionProbe: verifiedBunxVersion,
    });
    const parsed = JSON.parse(
      await readFile(join(cwd, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env?: Record<string, string> }
      >;
    };

    expect(first).toContain("Claude Code MCP: updated");
    expect(second).toContain("Claude Code MCP: skipped");
    expect(Object.keys(parsed.mcpServers).sort()).toEqual([
      "existing",
      "kyoso",
    ]);
    expect(parsed.mcpServers.kyoso).toMatchObject({
      command: "bunx",
      args: ["--package", "@kyo-so/cli", "kyoso", "mcp"],
      env: { OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}" },
    });
    expect(
      existsSync(
        join(skillDestination("claude-code", "project", cwd, home), "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("reports a conflict for an unrecognized existing skill", async () => {
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
    expect(output).toContain("Codex skill: conflict");
    expect(output).toContain("Rerun with --force");
    expect(await readFile(join(skillDir, "SKILL.md"), "utf8")).toBe("existing");
  });

  test("writes only the Codex skill when --skill-only is selected", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-skill-only-");
    const codexHome = join(home, "separate-codex-home");
    const configPath = join(codexHome, "config.toml");
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, "not valid toml [[", "utf8");

    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });

    const destination = skillDestination("codex", "project", cwd, home);
    expect(output).toContain("Codex skill: created");
    expect(output).not.toContain("Codex MCP");
    expect(await readFile(configPath, "utf8")).toBe("not valid toml [[");
    expect(existsSync(join(destination, "SKILL.md"))).toBe(true);
    expect(existsSync(join(destination, "agents", "openai.yaml"))).toBe(true);
    expect(
      await readFile(join(destination, "agents", "openai.yaml"), "utf8"),
    ).not.toContain("dependencies:");
    expect(existsSync(join(destination, SKILL_INSTALL_MARKER))).toBe(true);
  });

  test("requires a client and rejects MCP-only options for --skill-only", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-skill-flags-");
    const base = {
      cwd,
      write: false,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };

    await expect(runSetup(base)).rejects.toThrow("requires setup client");
    await expect(
      runSetup({ ...base, client: "codex", runner: "bunx" }),
    ).rejects.toThrow("cannot be combined with --runner");
    await expect(
      runSetup({ ...base, client: "codex", command: "node server.js" }),
    ).rejects.toThrow("cannot be combined with --command");
    await expect(
      runSetup({ ...base, client: "codex", withOpenRouter: true }),
    ).rejects.toThrow("cannot be combined with --with-openrouter");
  });

  test("shows Skill-only syntax in setup overview and every README", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-overview-");
    const overview = await runSetup({
      cwd,
      write: false,
      global: false,
      env: { HOME: home },
    });
    expect(overview).toContain(
      "kyoso setup codex --skill-only [--write] [--global] [--force]",
    );
    expect(overview).toContain(
      "kyoso setup claude-code --skill-only [--write] [--global] [--force]",
    );

    for (const readme of ["README.md", "README.ja.md", "README.zh-CN.md"]) {
      const content = await readFile(join(process.cwd(), readme), "utf8");
      expect(content).toContain(
        "kyoso setup codex --write --skill-only --global",
      );
      expect(content).toContain("kyoso setup claude-code --write --skill-only");
    }
  });

  test("adopts and updates the published 0.8.0 skill", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-adopt-");
    const destination = skillDestination("codex", "project", cwd, home);
    await mkdir(join(destination, ".."), { recursive: true });
    await cp(historicalSkillDir, destination, { recursive: true });

    expect(await hashSkillDirectory(destination)).toBe(
      "sha256:b16ea3f8141a01399b96dee650365d99df2b8c5fc99184d9cb22d5d72c106fd8",
    );
    const output = await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    });

    expect(output).toContain("Codex skill: updated");
    expect(output).toContain("adopt known 0.8.0 historical skill");
    expect(await hashSkillDirectory(destination)).toBe(CURRENT_SKILL_DIGEST);
    expect(existsSync(join(destination, SKILL_INSTALL_MARKER))).toBe(true);
  });

  test("detects managed user changes and --force replaces only the skill", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-force-");
    const configPath = join(home, ".codex", "config.toml");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(configPath, "user config", "utf8");
    const options = {
      cwd,
      client: "codex" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("codex", "project", cwd, home);
    await writeFile(join(destination, "SKILL.md"), "user change", "utf8");

    const conflict = await runSetup(options);
    expect(conflict).toContain("Codex skill: conflict");
    expect(conflict).toContain("managed digest");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(
      "user change",
    );

    const forced = await runSetup({ ...options, force: true });
    expect(forced).toContain("Codex skill: updated");
    expect(await hashSkillDirectory(destination)).toBe(CURRENT_SKILL_DIGEST);
    expect(await readFile(configPath, "utf8")).toBe("user config");
    expect(
      (await readdir(join(destination, ".."))).some(
        (name) =>
          name.startsWith(".kyoso-review.stage-") ||
          name === SKILL_INSTALL_BACKUP ||
          name === SKILL_INSTALL_TRANSACTION,
      ),
    ).toBe(false);
  });

  test("recovers a hard-killed replacement before applying another update", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-recover-");
    const options = {
      cwd,
      client: "codex" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("codex", "project", cwd, home);
    const backup = join(destination, "..", SKILL_INSTALL_BACKUP);
    await writeFile(join(destination, "SKILL.md"), "preserve me", "utf8");
    await rename(destination, backup);
    await writeInterruptedTransaction(destination);

    const dryRun = await runSetup({ ...options, write: false });
    expect(dryRun).toContain("Codex skill: dry-run");
    expect(dryRun).toContain("recover interrupted skill replacement");
    expect(existsSync(destination)).toBe(false);
    expect(await readFile(join(backup, "SKILL.md"), "utf8")).toBe(
      "preserve me",
    );

    const recovered = await runSetup(options);
    expect(recovered).toContain("Codex skill: updated");
    expect(recovered).toContain("recovered interrupted skill replacement");
    expect(await readFile(join(destination, "SKILL.md"), "utf8")).toBe(
      "preserve me",
    );
    expect(existsSync(backup)).toBe(false);
  });

  test("fails closed when an interrupted backup and destination both exist", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-ambiguous-");
    const options = {
      cwd,
      client: "codex" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("codex", "project", cwd, home);
    const backup = join(destination, "..", SKILL_INSTALL_BACKUP);
    await cp(destination, backup, { recursive: true });
    await writeFile(join(backup, "SKILL.md"), "backup copy", "utf8");
    await writeInterruptedTransaction(destination);

    await expect(runSetup(options)).rejects.toThrow(
      "Interrupted Skill replacement is ambiguous",
    );
    expect(existsSync(destination)).toBe(true);
    expect(await readFile(join(backup, "SKILL.md"), "utf8")).toBe(
      "backup copy",
    );
  });

  test("does not adopt an unmarked fixed-name backup", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-unmarked-backup-");
    const destination = skillDestination("codex", "project", cwd, home);
    const backup = join(destination, "..", SKILL_INSTALL_BACKUP);
    await mkdir(backup, { recursive: true });
    await writeFile(join(backup, "SKILL.md"), "unrelated", "utf8");

    await expect(
      runSetup({
        cwd,
        client: "codex",
        write: true,
        global: false,
        skillOnly: true,
        env: { HOME: home },
      }),
    ).rejects.toThrow("transaction marker is not a regular file");
    expect(existsSync(destination)).toBe(false);
    expect(await readFile(join(backup, "SKILL.md"), "utf8")).toBe("unrelated");
  });

  test("cleans a transaction marker left after the replacement committed", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-marker-cleanup-");
    const options = {
      cwd,
      client: "codex" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("codex", "project", cwd, home);
    const transaction = join(destination, "..", SKILL_INSTALL_TRANSACTION);
    await writeInterruptedTransaction(destination);

    const dryRun = await runSetup({ ...options, write: false });
    expect(dryRun).toContain("Codex skill: dry-run");
    expect(dryRun).toContain("clean completed Skill replacement marker");
    expect(existsSync(transaction)).toBe(true);

    const cleaned = await runSetup(options);
    expect(cleaned).toContain("Codex skill: updated");
    expect(cleaned).toContain("cleaned completed Skill replacement marker");
    expect(existsSync(transaction)).toBe(false);
    expect(await hashSkillDirectory(destination)).toBe(CURRENT_SKILL_DIGEST);
  });

  test("does not trust an invalid managed marker", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-invalid-marker-");
    const options = {
      cwd,
      client: "codex" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("codex", "project", cwd, home);
    await writeFile(
      join(destination, SKILL_INSTALL_MARKER),
      '{"schemaVersion":2}\n',
      "utf8",
    );

    const output = await runSetup(options);
    expect(output).toContain("Codex skill: conflict");
    expect(output).toContain("has an invalid schema");
    expect(await hashSkillDirectory(destination)).toBe(CURRENT_SKILL_DIGEST);
  });

  test("adopts a current legacy copy without replacing its files", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-current-adopt-");
    const options = {
      cwd,
      client: "claude-code" as const,
      write: true,
      global: false,
      skillOnly: true,
      env: { HOME: home },
    };
    await runSetup(options);
    const destination = skillDestination("claude-code", "project", cwd, home);
    await rm(join(destination, SKILL_INSTALL_MARKER));

    const output = await runSetup(options);
    expect(output).toContain("Claude Code skill: updated");
    expect(output).toContain(`adopt existing ${KYOSO_VERSION} skill`);
    expect(await hashSkillDirectory(destination)).toBe(CURRENT_SKILL_DIGEST);
  });

  test("does not add a managed marker when canonical source is the destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "kyoso-setup-canonical-self-"));
    const destination = join(root, ".agents", "skills", "kyoso-review");
    await mkdir(join(root, ".agents", "skills"), { recursive: true });
    await cp(
      join(process.cwd(), ".agents", "skills", "kyoso-review"),
      destination,
      { recursive: true },
    );

    const result = await ensureManagedSkill({
      sourceDir: destination,
      destinationDir: destination,
      trustedRoot: root,
      write: true,
      force: true,
    });

    expect(result.status).toBe("skipped");
    expect(result.detail).toContain(
      "canonical source is already the destination",
    );
    expect(existsSync(join(destination, SKILL_INSTALL_MARKER))).toBe(false);
  });

  test("rejects symlinks in the destination path", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-symlink-");
    const outside = join(home, "outside");
    await mkdir(outside);
    await symlink(outside, join(cwd, ".agents"));

    await expect(
      runSetup({
        cwd,
        client: "codex",
        write: true,
        global: false,
        skillOnly: true,
        env: { HOME: home },
      }),
    ).rejects.toThrow("contains a symlink");
    expect(existsSync(join(outside, "skills"))).toBe(false);
  });

  test("uses CODEX_HOME for MCP while global Codex skill stays under HOME", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-codex-home-");
    const codexHome = join(cwd, "codex-state");
    await mkdir(codexHome);

    await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: true,
      env: { HOME: home, CODEX_HOME: codexHome },
    });

    expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(
      existsSync(
        join(skillDestination("codex", "global", cwd, home), "SKILL.md"),
      ),
    ).toBe(true);
  });

  test("resolves a relative CODEX_HOME from the setup workspace", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-relative-codex-");
    const env = { HOME: home, CODEX_HOME: "codex-state" };

    await runSetup({
      cwd,
      client: "codex",
      write: true,
      global: false,
      env,
    });

    expect(resolveCodexConfigPath(env, cwd)).toBe(
      join(cwd, "codex-state", "config.toml"),
    );
    expect(existsSync(join(cwd, "codex-state", "config.toml"))).toBe(true);
  });

  test("resolves the Codex config and user Skill from separate roots", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-resolvers-");
    const codexHome = join(cwd, "codex-state");
    const env = { HOME: home, CODEX_HOME: codexHome };
    const configPath = resolveCodexConfigPath(env);
    const globalSkillPath = resolveCodexUserSkillPath(env);
    const projectSkillPath = join(cwd, ".agents", "skills", "kyoso-review");

    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      buildCodexMcpToml(commandForRunner("npx")),
      "utf8",
    );
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      "[mcp_servers.kyoso]\nenabled = false\n",
      "utf8",
    );
    await mkdir(projectSkillPath, { recursive: true });
    await writeFile(join(projectSkillPath, "SKILL.md"), "project", "utf8");
    await mkdir(globalSkillPath, { recursive: true });
    await writeFile(join(globalSkillPath, "SKILL.md"), "global", "utf8");

    const detected = detectSetup({ cwd, env });

    expect(configPath).toBe(join(codexHome, "config.toml"));
    expect(globalSkillPath).toBe(
      join(home, ".agents", "skills", "kyoso-review"),
    );
    expect(resolveCodexConfigPath({ HOME: home })).toBe(
      join(home, ".codex", "config.toml"),
    );
    expect(detected.codex).toMatchObject({
      mcp: true,
      skill: true,
      manualMcpStatus: "enabled",
      mcpPaths: [configPath],
      skillPaths: [projectSkillPath, globalSkillPath],
    });
  });

  test("detects Codex Plugin MCP overrides from the Codex config root", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-plugin-override-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    const env = { HOME: home, CODEX_HOME: codexHome };

    expect(detectCodexPluginMcpOverride({ cwd, env })).toEqual({
      status: "missing",
      path: configPath,
    });

    await mkdir(codexHome, { recursive: true });
    await writeFile(
      configPath,
      '[plugins."kyoso@kyoso".mcp_servers.kyoso]\n',
      "utf8",
    );
    expect(detectCodexPluginMcpOverride({ cwd, env })).toEqual({
      status: "enabled",
      path: configPath,
    });

    await writeFile(
      configPath,
      '[plugins."kyoso@kyoso".mcp_servers.kyoso]\nenabled = false\n',
      "utf8",
    );
    expect(detectCodexPluginMcpOverride({ cwd, env })).toEqual({
      status: "disabled",
      path: configPath,
    });

    await writeFile(configPath, "not valid toml [[", "utf8");
    expect(detectCodexPluginMcpOverride({ cwd, env })).toEqual({
      status: "unknown",
      path: configPath,
    });
  });

  test("fails closed for unprobed current-project Codex integration settings", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-project-codex-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    const env = { HOME: home, CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });

    await writeFile(
      configPath,
      ['[projects."' + cwd + '".mcp_servers.kyoso]', "enabled = true", ""].join(
        "\n",
      ),
      "utf8",
    );

    expect(detectSetup({ cwd, env }).codex.manualMcpStatus).toBe("unknown");
    expect(detectCodexPluginMcpOverride({ cwd, env }).status).toBe("unknown");

    await writeFile(
      configPath,
      ['[projects."' + cwd + '"]', 'trust_level = "trusted"', ""].join("\n"),
      "utf8",
    );
    expect(detectSetup({ cwd, env }).codex.manualMcpStatus).toBe("missing");
    expect(detectCodexPluginMcpOverride({ cwd, env }).status).toBe("missing");

    await writeFile(
      configPath,
      [
        '[projects."/different/project".mcp_servers.kyoso]',
        "enabled = true",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(detectSetup({ cwd, env }).codex.manualMcpStatus).toBe("missing");
    expect(detectCodexPluginMcpOverride({ cwd, env }).status).toBe("missing");
  });

  test("normalizes current-project config paths conservatively", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-project-path-");
    const codexHome = join(cwd, "codex-state");
    const configPath = join(codexHome, "config.toml");
    const alias = join(home, "workspace-alias");
    const env = { HOME: home, CODEX_HOME: codexHome };
    await mkdir(codexHome, { recursive: true });
    await symlink(cwd, alias, "dir");

    await writeFile(
      configPath,
      `[projects.${JSON.stringify(`${alias}/`)}.mcp_servers.kyoso]\nenabled = true\n`,
      "utf8",
    );
    expect(detectSetup({ cwd, env }).codex.manualMcpStatus).toBe("unknown");

    const homeProject = join(home, "project");
    await mkdir(homeProject, { recursive: true });
    await writeFile(
      configPath,
      '[projects."~/project/".mcp_servers.kyoso]\nenabled = true\n',
      "utf8",
    );
    expect(detectSetup({ cwd: homeProject, env }).codex.manualMcpStatus).toBe(
      "unknown",
    );
  });

  test("reports disabled and malformed manual MCP configuration safely", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-mcp-status-");
    const codexHome = join(cwd, "codex-state");
    const codexConfigPath = join(codexHome, "config.toml");
    const claudeConfigPath = join(home, ".claude.json");
    const env = { HOME: home, CODEX_HOME: codexHome };

    await mkdir(codexHome, { recursive: true });
    await writeFile(
      codexConfigPath,
      "[mcp_servers.kyoso]\nenabled = false\n",
      "utf8",
    );
    await writeFile(
      claudeConfigPath,
      JSON.stringify({ mcpServers: { kyoso: { enabled: false } } }),
      "utf8",
    );

    const disabled = detectSetup({ cwd, env });
    expect(disabled.codex).toMatchObject({
      mcp: false,
      manualMcpStatus: "disabled",
      mcpPaths: [codexConfigPath],
    });
    expect(disabled["claude-code"]).toMatchObject({
      mcp: false,
      manualMcpStatus: "disabled",
      mcpPaths: [claudeConfigPath],
    });

    await writeFile(codexConfigPath, "not valid toml [[", "utf8");
    await writeFile(claudeConfigPath, "{", "utf8");

    const malformed = detectSetup({ cwd, env });
    expect(malformed.codex).toMatchObject({
      mcp: false,
      manualMcpStatus: "unknown",
      mcpPaths: [codexConfigPath],
    });
    expect(malformed["claude-code"]).toMatchObject({
      mcp: false,
      manualMcpStatus: "unknown",
      mcpPaths: [claudeConfigPath],
    });
  });

  test("detects quoted Codex MCP table and nested Claude MCP config", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-detect-");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex", "config.toml"),
      '[mcp_servers."kyoso"]\ncommand = "npx"\nargs = ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"]\n',
      "utf8",
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [cwd]: {
            mcpServers: {
              kyoso: {
                command: "npx",
                args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
              },
            },
          },
        },
      }),
      "utf8",
    );

    const detected = detectSetup({ cwd, home });

    expect(detected.codex.mcp).toBe(true);
    expect(detected.codex.manualMcpStatus).toBe("enabled");
    expect(detected.codex.mcpPaths).toEqual([
      join(home, ".codex", "config.toml"),
    ]);
    expect(detected["claude-code"].mcp).toBe(true);
    expect(detected["claude-code"].manualMcpStatus).toBe("enabled");
    expect(detected["claude-code"].mcpPaths).toEqual([
      join(home, ".claude.json"),
    ]);
  });

  test("scopes nested Claude MCP config to the current project", async () => {
    const { cwd, home } = await setupTempDirs("kyoso-setup-claude-scope-");
    const configPath = join(home, ".claude.json");
    const otherProject = join(cwd, "other-project");

    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [otherProject]: { mcpServers: { kyoso: { enabled: true } } },
        },
      }),
      "utf8",
    );
    expect(detectSetup({ cwd, home })["claude-code"]).toMatchObject({
      mcp: false,
      manualMcpStatus: "missing",
      mcpPaths: [],
    });

    await writeFile(
      configPath,
      JSON.stringify({
        projects: {
          [cwd]: { mcpServers: { kyoso: { enabled: false } } },
          [otherProject]: { mcpServers: { kyoso: { enabled: true } } },
        },
      }),
      "utf8",
    );
    expect(detectSetup({ cwd, home })["claude-code"]).toMatchObject({
      mcp: false,
      manualMcpStatus: "disabled",
      mcpPaths: [configPath],
    });
  });

  test("omits OpenRouter from the default Claude MCP env placeholders", () => {
    expect(buildClaudeMcpEntry(commandForRunner("npx"))).toEqual({
      command: "npx",
      args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}",
      },
    });
  });

  test("adds OpenRouter to Claude MCP env placeholders only when requested", () => {
    expect(buildClaudeMcpEntry(commandForRunner("npx"), true)).toEqual({
      command: "npx",
      args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
      env: {
        OPENAI_API_KEY: "${OPENAI_API_KEY}",
        ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN}",
        OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
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

async function writeBunxProbeScript(
  path: string,
  invocationPath: string,
  body: string,
): Promise<void> {
  await writeFile(
    path,
    [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > ${JSON.stringify(invocationPath)}`,
      body,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(path, 0o755);
}

async function writeInterruptedTransaction(destination: string): Promise<void> {
  await writeFile(
    join(destination, "..", SKILL_INSTALL_TRANSACTION),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        installer: "@kyo-so/cli",
        destinationName: "kyoso-review",
        backupName: SKILL_INSTALL_BACKUP,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
