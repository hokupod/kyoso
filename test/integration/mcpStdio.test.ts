import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KYOSO_VERSION } from "../../src/core/constants.js";

describe("MCP stdio integration", () => {
  test("handshakes, lists tools, and calls plan_review through fake agents", async () => {
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
      expect(client.parseErrors).toEqual([]);
      expect(client.stderr).toBe("");
    } finally {
      await stopProcess(client.proc);
    }
  }, 15_000);
});

function startMcp(cwd: string) {
  const proc = spawn(
    "bun",
    [
      "run",
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
        CLAUDE_CODE_OAUTH_TOKEN: "",
        KYOSO_TEST_FAKE_AGENTS: "1",
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

  return {
    proc,
    parseErrors,
    get stderr() {
      return stderr;
    },
    async waitForResponse(id: number, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const response = responses.find((item) => item.id === id);
        if (response) return response;
        await Bun.sleep(20);
      }
      throw new Error(`Timed out waiting for MCP response ${id}`);
    },
  };
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
