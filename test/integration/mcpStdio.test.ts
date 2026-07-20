import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KYOSO_VERSION } from "../../src/core/constants.js";

describe("MCP stdio integration", () => {
  test("handshakes, lists tools, and calls plan_review without progress notifications", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-stdio-"));
    const client = startMcp(cwd);

    try {
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "kyoso-integration", version: "0.0.0" },
        },
      });
      const initializeResponse = await client.waitForResponse(1);
      const initializeResult = initializeResponse.result as {
        serverInfo?: { name?: string; version?: string };
      };

      expect(initializeResult.serverInfo).toEqual({
        name: "kyoso",
        version: KYOSO_VERSION,
      });

      writeJson(client.proc, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const toolsResponse = await client.waitForResponse(2);
      const toolsResult = toolsResponse.result as {
        tools?: Array<{ name?: string; inputSchema?: unknown }>;
      };

      expect(toolsResult.tools?.map((tool) => tool.name)).toEqual([
        "plan_review",
        "security_review",
        "diff_review",
      ]);
      expect(
        toolsResult.tools?.every((tool) => tool.inputSchema !== undefined),
      ).toBe(true);

      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "review plan",
            options: { maxAgentTimeoutMs: 2_000 },
          },
        },
      });
      const callResponse = await client.waitForResponse(3, 10_000);
      const callResult = callResponse.result as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const texts = callResult.content?.map((item) => item.text ?? "") ?? [];
      const jsonResult = JSON.parse(texts[1] ?? "{}") as {
        decision?: string;
        degraded?: boolean;
        agentOpinions?: Array<{ status?: string }>;
      };

      expect(texts[0]).toContain("**Decision:**");
      expect(jsonResult.decision).toBe("approve");
      expect(jsonResult.degraded).toBe(false);
      expect(
        jsonResult.agentOpinions?.map((opinion) => opinion.status),
      ).toEqual(["completed", "completed"]);
      expect(client.progressNotifications).toEqual([]);
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);

  test("sends monotonic progress only when the client provides a token", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-progress-"));
    const client = startMcp(cwd);

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "review plan",
            options: { maxAgentTimeoutMs: 2_000 },
          },
          _meta: { progressToken: "tok-1" },
        },
      });
      const callResponse = await client.waitForResponse(3, 10_000);
      const progress = client.progressNotifications.filter(
        (notification) => notification.params.progressToken === "tok-1",
      );
      const callResult = callResponse.result as {
        content?: Array<{ type?: string; text?: string }>;
      };

      expect(progress.length).toBeGreaterThan(0);
      expect(
        progress.map((notification) => notification.params.progress),
      ).toEqual(
        Array.from({ length: progress.length }, (_, index) => index + 1),
      );
      expect(
        progress.every(
          (notification) => typeof notification.params.message === "string",
        ),
      ).toBe(true);
      expect(
        progress.map((notification) => notification.params.message).join("\n"),
      ).not.toContain("Fake ACP subprocess finding");
      expect(callResult.content).toHaveLength(2);
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);

  test("keeps progress sequences independent for concurrent tool calls", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-progress-parallel-"));
    const client = startMcp(cwd);

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: { goal: "review first" },
          _meta: { progressToken: "tok-a" },
        },
      });
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: { goal: "review second" },
          _meta: { progressToken: "tok-b" },
        },
      });

      await Promise.all([
        client.waitForResponse(3, 10_000),
        client.waitForResponse(4, 10_000),
      ]);
      const progressA = client.progressNotifications.filter(
        (notification) => notification.params.progressToken === "tok-a",
      );
      const progressB = client.progressNotifications.filter(
        (notification) => notification.params.progressToken === "tok-b",
      );

      expect(progressA.length).toBeGreaterThan(0);
      expect(progressB.length).toBeGreaterThan(0);
      expect(
        progressA.map((notification) => notification.params.progress),
      ).toEqual(
        Array.from({ length: progressA.length }, (_, index) => index + 1),
      );
      expect(
        progressB.map((notification) => notification.params.progress),
      ).toEqual(
        Array.from({ length: progressB.length }, (_, index) => index + 1),
      );
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);

  test("cancels a hanging request without a normal response and keeps the server usable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-cancel-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-mcp-home-"));
    const configHome = join(home, "xdg");
    const fixture = join(process.cwd(), "test/fixtures/fake-acp-agent.ts");
    const pidPath = join(cwd, "fake-acp.pid");
    const modePath = join(cwd, "fake-acp-mode");
    const wrapper = join(cwd, "fake-acp-hang-once.mjs");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      wrapper,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        `const modePath = ${JSON.stringify(modePath)};`,
        "if (existsSync(modePath)) {",
        '  process.env.FAKE_ACP_MODE = "happy";',
        "} else {",
        '  writeFileSync(modePath, "hang", "utf8");',
        '  process.env.FAKE_ACP_MODE = "hang";',
        "}",
        `await import(${JSON.stringify(fixture)});`,
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(configHome, "kyoso", "config.toml"),
      `[agents.codex]
command = "bun"
args = ["run", ${JSON.stringify(wrapper)}]
timeoutMs = 5000

[agents.codex.env]
FAKE_ACP_PID_FILE = ${JSON.stringify(pidPath)}
FAKE_ACP_FINDING_SEVERITY = "none"

[agents.claude]
enabled = false
`,
      "utf8",
    );
    const client = startMcp(cwd, {
      args: [],
      env: {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        KYOSO_TEST_FAKE_AGENTS: "",
      },
    });

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "cancel hanging review",
            options: { maxAgentTimeoutMs: 5_000 },
          },
        },
      });
      await waitFor(() => existsSync(pidPath));
      const pid = Number(await readFile(pidPath, "utf8"));
      await Bun.sleep(50);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "user" },
      });

      const cancelledResponse = await client.waitForResponseOrTimeout(3, 750);
      expect(cancelledResponse?.result).toBeUndefined();
      await waitFor(() => !isProcessAlive(pid));

      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: { goal: "review after cancellation" },
        },
      });
      const followUpResponse = await client.waitForResponse(4, 10_000);
      const followUpResult = followUpResponse.result as {
        content?: Array<{ type?: string }>;
      };

      expect(followUpResult.content).toHaveLength(2);
      expect(
        client
          .responsesForId(3)
          .every((response) => response.result === undefined),
      ).toBe(true);
      expect(client.progressNotifications).toEqual([]);
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 20_000);

  test("forwards allow-unknown-config to tool calls", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-allow-unknown-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-mcp-home-"));
    const configHome = join(home, "xdg");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      join(configHome, "kyoso", "config.toml"),
      `[network]
defautMode = "unrestricted"
`,
      "utf8",
    );
    const client = startMcp(cwd, {
      args: ["--allow-unknown-config"],
      env: { HOME: home, XDG_CONFIG_HOME: configHome },
    });

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "review plan",
            options: { maxAgentTimeoutMs: 2_000 },
          },
        },
      });
      const callResponse = await client.waitForResponse(3, 10_000);
      const callResult = callResponse.result as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const texts = callResult.content?.map((item) => item.text ?? "") ?? [];
      const jsonResult = JSON.parse(texts[1] ?? "{}") as {
        decision?: string;
        audit?: { warnings?: string[] };
      };

      expect(jsonResult.decision).toBe("approve");
      expect(jsonResult.audit?.warnings?.join("\n")).toContain(
        "security-sensitive unknown settings",
      );
      expect(jsonResult.audit?.warnings?.join("\n")).toContain(
        "network.defautMode",
      );
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);

  test("returns subprocess execution identity in MCP JSON and Markdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-identity-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-mcp-home-"));
    const configHome = join(home, "xdg");
    const fixture = join(process.cwd(), "test/fixtures/fake-acp-agent.ts");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      join(configHome, "kyoso", "config.toml"),
      `[agents.codex]
enabled = false

[agents.claude]
command = "bun"
args = ["run", ${JSON.stringify(fixture)}]
model = "claude-mcp-requested"
timeoutMs = 5000

[agents.claude.env]
FAKE_ACP_MODE = "happy"
FAKE_ACP_FINDING_SEVERITY = "none"
FAKE_ACP_REPORTED_PROVIDER = "anthropic"
FAKE_ACP_REPORTED_MODEL = "claude-mcp-reported"
`,
      "utf8",
    );
    const client = startMcp(cwd, {
      args: [],
      env: {
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        KYOSO_TEST_FAKE_AGENTS: "",
      },
    });

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "review plan",
            currentPlan: "do it",
            selectedFiles: [
              { path: "src/foo.ts", content: "export const foo = 1;" },
            ],
            options: { maxAgentTimeoutMs: 5_000 },
          },
        },
      });
      const callResponse = await client.waitForResponse(3, 15_000);
      const callResult = callResponse.result as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const texts = callResult.content?.map((item) => item.text ?? "") ?? [];
      const jsonResult = JSON.parse(texts[1] ?? "{}") as {
        audit?: {
          modelCalls?: Array<{ executionIdentity?: unknown }>;
        };
      };
      const identity = {
        providerRoute: "claude_default",
        requestedModel: "claude-mcp-requested",
        reportedProvider: "anthropic",
        reportedModel: "claude-mcp-reported",
        reportingStatus: "reported",
      };

      expect(jsonResult.audit?.modelCalls?.[0]?.executionIdentity).toEqual(
        identity,
      );
      expect(texts[0]).toContain(
        "primary/claude: route=claude_default, requested=claude-mcp-requested, reportedProvider=anthropic, reportedModel=claude-mcp-reported, reporting=reported",
      );
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 20_000);

  test("rejects security-sensitive unknown config in MCP calls by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-mcp-reject-unknown-"));
    const home = await mkdtemp(join(tmpdir(), "kyoso-mcp-home-"));
    const configHome = join(home, "xdg");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      join(configHome, "kyoso", "config.toml"),
      `[network]
defautMode = "unrestricted"
`,
      "utf8",
    );
    const client = startMcp(cwd, {
      args: [],
      env: { HOME: home, XDG_CONFIG_HOME: configHome },
    });

    try {
      await initializeMcp(client);
      writeJson(client.proc, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "plan_review",
          arguments: {
            goal: "review plan",
            options: { maxAgentTimeoutMs: 2_000 },
          },
        },
      });
      const callResponse = await client.waitForResponse(3, 10_000);
      const errorText = JSON.stringify(callResponse);

      expect(errorText).toContain(
        "Security-sensitive unknown config settings rejected",
      );
      expect(errorText).toContain("network.defautMode");
      expectJsonRpcStdout(client);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);
});

function startMcp(
  cwd: string,
  options: { args?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const proc = spawn(
    "bun",
    [
      "run",
      join(process.cwd(), "src/cli/main.ts"),
      "mcp",
      ...(options.args ?? ["--ignore-config"]),
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
        CLAUDE_CODE_OAUTH_TOKEN: "",
        KYOSO_TEST_FAKE_AGENTS: "1",
        XDG_STATE_HOME: `${cwd}-audit-state`,
        ...options.env,
      },
    },
  );
  const messages: Array<Record<string, unknown>> = [];
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
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        parseErrors.push(line);
      }
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  return {
    proc,
    parseErrors,
    get messages() {
      return messages;
    },
    get progressNotifications(): ProgressNotification[] {
      return messages.flatMap((message) =>
        isProgressNotification(message) ? [message] : [],
      );
    },
    get stdoutRemainder() {
      return stdoutBuffer;
    },
    get stderr() {
      return stderr;
    },
    async waitForResponse(id: number, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = messages.find((item) => item.id === id);
        if (response) return response;
        await Bun.sleep(20);
      }
      throw new Error(`Timed out waiting for MCP response ${id}`);
    },
    async waitForResponseOrTimeout(id: number, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = messages.find((item) => item.id === id);
        if (response) return response;
        await Bun.sleep(20);
      }
      return undefined;
    },
    responsesForId(id: number) {
      return messages.filter((item) => item.id === id);
    },
  };
}

async function initializeMcp(
  client: ReturnType<typeof startMcp>,
): Promise<void> {
  writeJson(client.proc, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "kyoso-integration", version: "0.0.0" },
    },
  });
  await client.waitForResponse(1);
  writeJson(client.proc, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
}

function writeJson(
  proc: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
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

type ProgressNotification = {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    message?: unknown;
  };
};

function isProgressNotification(
  message: Record<string, unknown>,
): message is ProgressNotification {
  const params = message.params;
  return (
    message.method === "notifications/progress" &&
    isRecord(params) &&
    (typeof params.progressToken === "string" ||
      typeof params.progressToken === "number") &&
    typeof params.progress === "number"
  );
}

function expectJsonRpcStdout(client: ReturnType<typeof startMcp>): void {
  expect(client.parseErrors).toEqual([]);
  expect(client.stdoutRemainder.trim()).toBe("");
  expect(client.messages.every((message) => message.jsonrpc === "2.0")).toBe(
    true,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(20);
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
