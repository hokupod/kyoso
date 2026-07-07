import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessAcpAgentManager } from "../../src/acp/AcpAgentProcess.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  kyosoConfigSchema,
  type KyosoConfig,
} from "../../src/config/schema.js";
import type { AgentRunInput } from "../../src/core/types.js";

describe("SubprocessAcpAgentManager ACP integration", () => {
  test("completes a happy-path ACP session and normalizes findings", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("happy"));

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).toContain("read snapshot context");
    expect(result.normalized?.findings[0]?.title).toBe(
      "Fake ACP subprocess finding",
    );
    expect(result.normalized?.testsToAdd).toContain("fake ACP subprocess test");
  });

  test("keeps malformed ACP output as a completed low-confidence parse fallback", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("garbage"));

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("completed");
    expect(result.normalized?.findings[0]).toMatchObject({
      severity: "info",
      confidence: "low",
      title: "Agent output could not be parsed",
    });
    expect(result.normalized?.summary).toContain("No JSON object found");
  });

  test("classifies immediate ACP child crashes from stderr", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("crash"));

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AUTH_FAILED");
    expect(result.error?.message).toContain("authentication failed");
    expect(result.error?.detail).toContain("auth failed");
  });

  test("times out hung ACP sessions and terminates the child process", async () => {
    const cwd = await fakeWorkspace();
    const pidPath = join(cwd, "fake-agent.pid");
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig("hang", { FAKE_ACP_PID_FILE: pidPath }),
    );

    const result = await manager.runAgent(agentInput(cwd, { timeoutMs: 200 }));
    const pid = Number(await readFile(pidPath, "utf8"));

    expect(result.status).toBe("timeout");
    expect(result.error?.code).toBe("AGENT_TIMEOUT");
    await Bun.sleep(1_000);
    expect(isProcessAlive(pid)).toBe(false);
  });
});

type FakeAcpMode = "happy" | "garbage" | "crash" | "hang";

function fakeAcpConfig(
  mode: FakeAcpMode,
  env: Record<string, string> = {},
): KyosoConfig {
  const baseConfig = kyosoConfigSchema.parse(defaultConfig);
  return {
    ...baseConfig,
    agents: {
      codex: {
        ...baseConfig.agents.codex,
        command: "bun",
        args: ["run", join(process.cwd(), "test/fixtures/fake-acp-agent.ts")],
        env: {
          ...baseConfig.agents.codex.env,
          FAKE_ACP_MODE: mode,
          ...env,
        },
      },
      claude: {
        ...baseConfig.agents.claude,
        enabled: false,
      },
    },
  };
}

async function fakeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "kyoso-acp-"));
  await mkdir(join(cwd, "context"), { recursive: true });
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(
    join(cwd, "context/request.json"),
    JSON.stringify({ goal: "review plan" }),
    "utf8",
  );
  await writeFile(join(cwd, "src/foo.ts"), "export const foo = 1;\n", "utf8");
  return cwd;
}

function agentInput(
  workspaceDir: string,
  overrides: Partial<AgentRunInput> = {},
): AgentRunInput {
  return {
    traceId: "tr_acp_integration",
    agent: "codex",
    role: "combined_reviewer",
    tool: "plan_review",
    prompt: "review plan",
    workspaceDir,
    timeoutMs: 2_000,
    networkMode: "model_only",
    ...overrides,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
