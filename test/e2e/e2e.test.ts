import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listKyosoMcpTools } from "../../src/mcp/server.js";
import { runDoctor } from "../../src/cli/doctor.js";

describe("e2e surfaces", () => {
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
    expect(output).toContain("raw agent output: disabled");
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
      'hint: replace command "npx" with "bunx" in kyoso.config.ts',
    );
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
    expect(output).toContain("provider: anthropic");
    expect(output).toContain(
      "billing: direct provider API calls (pay-per-token billing)",
    );
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
});

function writeJson(
  proc: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
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
