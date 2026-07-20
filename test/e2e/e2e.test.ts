import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listKyosoMcpTools } from "../../src/mcp/server.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { runInit } from "../../src/cli/init.js";

describe("e2e surfaces", () => {
  test("CLI help lists review command output and override flags", async () => {
    const proc = Bun.spawn(
      ["bun", "run", join(process.cwd(), "src/cli/main.ts")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.match(/\[--set <key>=<value>\]\.\.\./g)).toHaveLength(3);
    expect(stdout.match(/\[--focus <lens>\]\.\.\./g)).toHaveLength(3);
    expect(stdout).toContain(
      "[--set <key>=<value>]... [--json] [--progress auto|plain|jsonl|off] [--allow-secret-redaction]",
    );
    expect(stdout).toContain(
      "setup codex|claude-code --skill-only [--write] [--global] [--force]",
    );
    expect(stdout).toContain("[--with-openrouter]");
  });

  test("CLI maps repeatable typed focus into review coverage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-focus-cli-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-focus-home-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review focused plan",
        "--focus",
        "performance",
        "--focus",
        "documentation",
        "--ignore-config",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_STATE_HOME: join(home, "state"),
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const result = JSON.parse(stdout);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(result.coverage.requiredLenses).toEqual(
      expect.arrayContaining(["performance", "documentation"]),
    );
  });

  test("CLI keeps JSON stdout valid while plain progress uses stderr", async () => {
    const { stdout, stderr, exitCode } = await runProgressReview("plain", true);

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain("[00:");
    expect(stderr).toContain("Kyoso review started");
  });

  test("CLI off progress leaves stderr empty", async () => {
    const { stdout, stderr, exitCode } = await runProgressReview("off", true);

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toBe("");
  });

  test("CLI JSONL progress writes parseable events to stderr", async () => {
    const { stdout, stderr, exitCode } = await runProgressReview("jsonl", true);
    const events = stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string });

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(events[0]?.type).toBe("review_started");
    expect(events.at(-1)?.type).toBe("review_completed");
  });

  test("CLI never mixes plain progress into Markdown stdout", async () => {
    const { stdout, stderr, exitCode } = await runProgressReview(
      "plain",
      false,
    );

    expect(exitCode).toBe(0);
    expect(stdout).not.toMatch(/^\[\d{2}:\d{2}\]/m);
    expect(stderr).toContain("Kyoso review started");
  });

  test("CLI SIGINT exits 130 after cancelling an in-flight review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-progress-sigint-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-progress-sigint-home-"));
    const fixture = join(process.cwd(), "test/fixtures/fake-acp-agent.ts");
    const pidPath = join(cwd, "sigint-agent.pid");
    await mkdir(join(home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
command = "bun"
args = ["run", ${JSON.stringify(fixture)}]
timeoutMs = 5000

[agents.codex.env]
FAKE_ACP_MODE = "hang_ignore_sigterm"
FAKE_ACP_PID_FILE = ${JSON.stringify(pidPath)}

[agents.claude]
enabled = false
`,
      "utf8",
    );
    const proc = spawn(
      "bun",
      [
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "cancel review",
        "--json",
        "--progress",
        "plain",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_STATE_HOME: join(home, "state"),
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
      },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exit = new Promise<number | null>((resolve) => {
      proc.once("close", (code) => resolve(code));
    });

    await waitForCondition(
      () => stderr.includes("Primary reviewers started: codex"),
      5_000,
    );
    await waitForCondition(() => existsSync(pidPath), 5_000);
    proc.kill("SIGINT");

    expect(await exit).toBe(130);
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(isProcessAlive(pid)).toBe(false);
    expect(stderr).toContain(
      "Cancelling... (press Ctrl-C again to force quit)",
    );
    expect(stderr).toContain("Review cancelled.");
  });

  test("CLI JSONL progress keeps stderr parseable while cancelling", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-progress-jsonl-sigint-"));
    const home = await mkdtemp(
      join(tmpdir(), "kyoso-progress-jsonl-sigint-home-"),
    );
    const fixture = join(process.cwd(), "test/fixtures/fake-acp-agent.ts");
    const pidPath = join(cwd, "jsonl-sigint-agent.pid");
    await mkdir(join(home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
command = "bun"
args = ["run", ${JSON.stringify(fixture)}]
timeoutMs = 5000

[agents.codex.env]
FAKE_ACP_MODE = "hang"
FAKE_ACP_PID_FILE = ${JSON.stringify(pidPath)}

[agents.claude]
enabled = false
`,
      "utf8",
    );
    const proc = spawn(
      "bun",
      [
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "cancel JSONL review",
        "--json",
        "--progress",
        "jsonl",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_STATE_HOME: join(home, "state"),
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
      },
    );
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const exit = new Promise<number | null>((resolve) => {
      proc.once("close", (code) => resolve(code));
    });

    await waitForCondition(() => existsSync(pidPath), 5_000);
    await waitForCondition(
      () => stderr.includes('"type":"agent_started"'),
      5_000,
    );
    proc.kill("SIGINT");

    expect(await exit).toBe(130);
    const lines = stderr.split("\n").filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines.map((line) => JSON.parse(line).type)).toContain(
      "review_cancelled",
    );
  });

  test("CLI rejects an unknown focus lens", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--focus",
        "security",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --focus value "security".');
  });

  test("CLI parses --skill-only without producing an MCP step", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-skill-only-cli-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-skill-only-home-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "setup",
        "codex",
        "--skill-only",
      ],
      {
        cwd,
        env: { ...process.env, HOME: home, CODEX_HOME: join(home, "state") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Codex skill: dry-run");
    expect(stdout).not.toContain("Codex MCP");
  });

  test("CLI parses --force and rejects invalid --skill-only combinations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-skill-force-cli-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-skill-force-home-"));
    const skillDir = join(cwd, ".agents", "skills", "kyoso-review");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "user copy", "utf8");

    const forced = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "setup",
        "codex",
        "--skill-only",
        "--force",
      ],
      {
        cwd,
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const forcedOutput = await new Response(forced.stdout).text();
    expect(await forced.exited).toBe(0);
    expect(forcedOutput).toContain("Codex skill: dry-run");
    expect(forcedOutput).toContain("force replace");

    for (const args of [
      ["setup", "--skill-only"],
      ["setup", "codex", "--skill-only", "--runner", "npx"],
      ["setup", "codex", "--skill-only", "--command", "node server.js"],
      ["setup", "codex", "--skill-only", "--with-openrouter"],
    ]) {
      const invalid = Bun.spawn(
        ["bun", "run", join(process.cwd(), "src/cli/main.ts"), ...args],
        {
          cwd,
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await invalid.exited).toBe(1);
      expect(await new Response(invalid.stderr).text()).toContain(
        args.includes("--runner")
          ? "cannot be combined with --runner"
          : args.includes("--command")
            ? "cannot be combined with --command"
            : args.includes("--with-openrouter")
              ? "cannot be combined with --with-openrouter"
              : "requires setup client",
      );
    }
  });

  test("CLI JSON exposes skipped untrusted config warnings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-untrusted-json-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-untrusted-home-"));
    await writeFile(
      join(cwd, "kyoso.config.ts"),
      'throw new Error("config should not execute without trust");\nexport default {};\n',
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review config trust reporting",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_STATE_HOME: join(home, "state"),
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
          KYOSO_TRUST_STORE_PATH: join(home, "trusted-configs.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const result = JSON.parse(stdout);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(result.audit.warnings).toContainEqual(
      expect.stringContaining("untrusted config was not executed"),
    );
  });

  test("MCP registers stable tool names", () => {
    expect(listKyosoMcpTools()).toEqual([
      "plan_review",
      "security_review",
      "diff_review",
    ]);
  });

  test("doctor works without credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-doctor-home-"));
    const output = await runDoctor({
      cwd,
      ignoreConfig: true,
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });
    expect(output).toContain("Kyoso doctor");
    expect(output).toContain("Codex registration: missing");
    expect(output).toContain("Claude Code kyoso-review: missing");
    expect(output).toContain("ACP agents");
    expect(output).toContain(
      "auth: set ANTHROPIC_API_KEY (API billing) or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (subscription)",
    );
    expect(output).toContain("provider: deterministic_fallback");
    expect(output).toContain("billing: none (deterministic fallback)");
    expect(output).toContain("state root: available");
    expect(output).toContain("raw agent output: disabled");
  });

  test("doctor reports config layers and TypeScript migration hints", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-config-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-doctor-home-"));
    await writeFile(
      join(cwd, "kyoso.toml"),
      `[verification]
enabled = true
`,
      "utf8",
    );
    await writeFile(join(cwd, "kyoso.config.ts"), "export default {};\n");

    const output = await runDoctor({
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: home },
    });

    expect(output).toContain(`global config.toml: not found`);
    expect(output).toContain(`kyoso.toml: found ${join(cwd, "kyoso.toml")}`);
    expect(output).toContain("kyoso.config.ts: ignored");
    expect(output).toContain("kyoso.config.ts was ignored");
  });

  test("doctor reports unknown global config keys as warnings", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-unknown-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-doctor-home-"));
    const configHome = join(home, "xdg");
    const configPath = join(configHome, "kyoso", "config.toml");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      configPath,
      `[nework]
defaultMode = "unrestricted"

[network]
defautMode = "unrestricted"

["\\u001B[31m"]
enabled = true
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd,
      allowUnknownConfig: true,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: configHome,
      },
    });

    expect(output).toContain(
      `warning: unknown settings in ${configPath} were ignored:`,
    );
    expect(output).toContain(
      `warning: security-sensitive unknown settings in ${configPath} were ignored:`,
    );
    expect(output).toContain("nework.defaultMode");
    expect(output).toContain("network.defautMode");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("network default: model_only");
    await expect(
      runDoctor({
        cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_CONFIG_HOME: configHome,
        },
      }),
    ).rejects.toThrow("Security-sensitive unknown config settings rejected");
  });

  test("doctor suggests bunx when npx is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-bunx-"));
    await writeFile(join(cwd, "bunx"), "", "utf8");
    const output = await runDoctor({
      cwd,
      ignoreConfig: true,
      env: { PATH: cwd },
    });

    expect(output).toContain(
      'hint: set agents.<name>.command = "bunx" in config.toml',
    );
  });

  test("init writes kyoso.toml", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-init-"));

    const output = await runInit({ cwd, force: false });
    const config = await readFile(join(cwd, "kyoso.toml"), "utf8");

    expect(output).toContain("kyoso.toml: created");
    expect(config).toContain("[network]");
    expect(config).toContain('defaultMode = "model_only"');
  });

  test("doctor suggests single-agent config when only one backend command exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-single-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-doctor-single-home-"));
    await writeFile(join(cwd, "claude-agent"), "", "utf8");
    await writeFile(
      join(cwd, "kyoso.config.ts"),
      `import { defineConfig } from "@kyo-so/cli";
export default defineConfig({
  agents: {
    codex: { command: "missing-codex" },
    claude: { command: "claude-agent" },
  },
});
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd,
      trustConfig: true,
      env: { PATH: cwd, HOME: home },
    });

    expect(output).toContain(
      "single-agent mode: set agents.codex.enabled: false to use claude only",
    );
  });

  test("doctor accepts Claude Code OAuth token for subscription auth", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-oauth-"));
    const output = await runDoctor({
      cwd,
      ignoreConfig: true,
      env: {
        PATH: process.env.PATH ?? "",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      },
    });

    expect(output).toContain("auth: detected Claude Code OAuth token");
    expect(output).toContain("provider: deterministic_fallback");
    expect(output).not.toContain("existing local Claude credentials");
  });

  test("doctor warns when Claude API key and OAuth token are both set", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-both-"));
    const output = await runDoctor({
      cwd,
      ignoreConfig: true,
      env: {
        PATH: process.env.PATH ?? "",
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      },
    });

    expect(output).toContain(
      "auth policy: Kyoso forwards only CLAUDE_CODE_OAUTH_TOKEN; set agents.claude.auth.preferApiKey to true to use ANTHROPIC_API_KEY",
    );
    expect(output).toContain("provider: deterministic_fallback");
    expect(output).toContain("billing: none (deterministic fallback)");
  });

  test("MCP stdio starts and lists tools without stdout pollution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-"));
    const proc = spawn(
      "bun",
      [
        join(process.cwd(), "src/cli/main.ts"),
        "mcp",
        "--ignore-config",
        "--network",
        "model_only",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
      },
    );
    const responses: Array<Record<string, unknown>> = [];
    const parseErrors: string[] = [];
    let stdoutBuffer = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          responses.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          parseErrors.push(line);
        }
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    try {
      writeJson(proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "kyoso-e2e", version: "0.0.0" },
        },
      });
      await waitForResponse(responses, 1);
      writeJson(proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      writeJson(proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const toolsResponse = await waitForResponse(responses, 2);
      const result = toolsResponse.result as {
        tools?: Array<{ name: string }>;
      };

      expect(parseErrors).toEqual([]);
      expect(stderr).toBe("");
      expect(result.tools?.map((tool) => tool.name)).toEqual([
        "plan_review",
        "security_review",
        "diff_review",
      ]);
    } finally {
      await stopProcess(proc);
    }
  });

  test("CLI security JSON blocks fake secrets before agent execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-secret-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(
      join(cwd, "src/config.ts"),
      "export const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';",
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        join(process.cwd(), "src/cli/main.ts"),
        "security",
        "--goal",
        "review secret handling",
        "--file",
        "src/config.ts",
        "--ignore-config",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const result = JSON.parse(stdout);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(result.decision).toBe("block");
    expect(result.findings[0].category).toBe("secret");
    expect(
      result.agentOpinions.every(
        (opinion: { status: string }) => opinion.status === "skipped",
      ),
    ).toBe(true);
  });

  test("CLI preserves network default from config when --network is omitted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-cli-"));
    const configPath = join(cwd, "kyoso.config.ts");
    await writeFile(
      configPath,
      `import { defineConfig } from "@kyo-so/cli";
export default defineConfig({
  network: { defaultMode: "unrestricted" },
});
`,
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--repo-summary",
        "repo",
        "--config",
        configPath,
        "--trust-config",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
          KYOSO_TRUST_STORE_PATH: join(cwd, "trusted-configs.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).audit.networkMode).toBe("unrestricted");
  });

  test("CLI rejects unknown network mode values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-network-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--network",
        "typo",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stdout).toBe("");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Invalid --network value "typo"');
  });

  test("CLI rejects missing network mode values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-network-missing-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--network",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stdout).toBe("");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Missing value for --network");
  });

  test("CLI diff applies repeatable --set overrides to ACP config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-set-effort-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-set-home-"));
    const fixture = join(process.cwd(), "test/fixtures/fake-acp-agent.ts");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "foo.ts"), "export const foo = 1;\n");
    await mkdir(join(home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
enabled = false

[agents.claude]
command = "bun"
args = ["run", ${JSON.stringify(fixture)}]
model = "claude-cli-requested"
timeoutMs = 5000
`,
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "diff",
        "--goal",
        "review diff",
        "--diff",
        "diff --git a/src/a.ts b/src/a.ts",
        "--file",
        "src/foo.ts",
        "--set",
        "agents.claude.effort=high",
        "--set",
        "agents.claude.timeoutMs=4000",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const result = JSON.parse(stdout);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(result.agentsUsed).toEqual(["claude"]);
    expect(result.agentOpinions[0].summary).toContain(
      "configOption=effort:high",
    );
    expect(result.audit.modelCalls[0].executionIdentity).toEqual({
      providerRoute: "claude_default",
      requestedModel: "claude-cli-requested",
      reportingStatus: "requested_only",
    });
    expect(result.summaryMarkdown).toContain(
      "primary/claude: route=claude_default, requested=claude-cli-requested, reporting=requested_only",
    );
  });

  test("CLI applies --set with --ignore-config", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-set-ignore-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--repo-summary",
        "repo",
        "--ignore-config",
        "--set",
        "agents.codex.enabled=false",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).agentsUsed).toEqual(["claude"]);
  });

  test("CLI security applies --set overrides", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-set-security-"));
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "security",
        "--goal",
        "review security",
        "--diff",
        "diff --git a/src/a.ts b/src/a.ts",
        "--ignore-config",
        "--set",
        "agents.codex.enabled=false",
        "--json",
      ],
      {
        cwd,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          CODEX_API_KEY: "",
          ANTHROPIC_API_KEY: "",
          KYOSO_TEST_FAKE_AGENTS: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).agentsUsed).toEqual(["claude"]);
  });

  test("CLI rejects malformed, unknown, and schema-invalid --set values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-set-invalid-"));
    const cases = [
      {
        args: ["--set", "agents.claude.effort"],
        message: "Expected key=value",
      },
      {
        args: ["--set", "workspace.root=/tmp/elsewhere"],
        message: 'Unknown --set key "workspace.root"',
      },
      {
        args: ["--set", "agents.claude.timeoutMs=-1"],
        message: 'Invalid --set value "agents.claude.timeoutMs=-1"',
      },
      {
        args: ["--set"],
        message: "Missing value for --set. Expected key=value.",
      },
    ];

    for (const testCase of cases) {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          join(process.cwd(), "src/cli/main.ts"),
          "plan",
          "--goal",
          "review",
          "--ignore-config",
          ...testCase.args,
        ],
        {
          cwd,
          env: {
            ...process.env,
            OPENAI_API_KEY: "",
            CODEX_API_KEY: "",
            ANTHROPIC_API_KEY: "",
            KYOSO_TEST_FAKE_AGENTS: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      expect(stdout).toBe("");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(testCase.message);
    }
  });
});

function writeJson(
  proc: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

async function runProgressReview(
  progress: "plain" | "off" | "jsonl",
  json: boolean,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = await mkdtemp(join(tmpdir(), "kyoso-progress-cli-"));
  const home = await mkdtemp(join(tmpdir(), "kyoso-progress-home-"));
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      join(process.cwd(), "src/cli/main.ts"),
      "plan",
      "--goal",
      "review progress",
      "--ignore-config",
      "--progress",
      progress,
      ...(json ? ["--json"] : []),
    ],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        XDG_STATE_HOME: join(home, "state"),
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        KYOSO_TEST_FAKE_AGENTS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const attempts = Math.ceil(timeoutMs / 10);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForResponse(
  responses: Array<Record<string, unknown>>,
  id: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = responses.find((item) => item.id === id);
    if (response) return response;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for MCP response ${id}`);
}

async function stopProcess(
  proc: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await Bun.sleep(20);
  }
  proc.kill("SIGKILL");
}
