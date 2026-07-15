import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessAcpAgentManager } from "../../src/acp/AcpAgentProcess.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  kyosoConfigSchema,
  type KyosoConfig,
} from "../../src/config/schema.js";
import type { AgentName, AgentRunInput } from "../../src/core/types.js";

describe("SubprocessAcpAgentManager ACP integration", () => {
  test("completes a happy-path ACP session and normalizes findings", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("happy"));
    let startEvents = 0;

    const result = await manager.runAgent(
      agentInput(cwd, { onStarted: () => (startEvents += 1) }),
    );

    expect(result.status).toBe("completed");
    expect(startEvents).toBe(1);
    expect(result.normalized?.summary).toContain("read snapshot context");
    expect(result.normalized?.findings[0]?.title).toBe(
      "Fake ACP subprocess finding",
    );
    expect(result.normalized?.testsToAdd).toContain("fake ACP subprocess test");
  });

  test("does not settle a spawned agent before asynchronous start tracing completes", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("happy"));
    let releaseStartedWrite: (() => void) | undefined;
    const startedWrite = new Promise<void>((resolve) => {
      releaseStartedWrite = resolve;
    });
    let onStartedCalled = false;

    const resultPromise = manager.runAgent(
      agentInput(cwd, {
        onStarted: () => {
          onStartedCalled = true;
          return startedWrite;
        },
      }),
    );

    await waitFor(() => onStartedCalled);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Bun.sleep(100);
    expect(settled).toBe(false);

    releaseStartedWrite?.();
    expect((await resultPromise).status).toBe("completed");
  });

  test("forwards the OpenRouter preset without exposing the key in output", async () => {
    const cwd = await fakeWorkspace();
    const key = "openrouter-subprocess-test-key";
    const manager = new SubprocessAcpAgentManager(
      openRouterAcpConfig("happy", { OPENROUTER_API_KEY: key }),
    );

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).toContain(
      "OPENROUTER_API_KEY_PRESENT=true",
    );
    expect(result.normalized?.summary).toContain(
      "MODEL_PROVIDER=kyoso-openrouter",
    );
    expect(result.normalized?.summary).toContain(
      "CODEX_CONFIG_MODEL=openai/o4-mini",
    );
    expect(result.normalized?.summary).toContain(
      "CODEX_CONFIG_OPENROUTER_PRESET=true",
    );
    expect(JSON.stringify(result)).not.toContain(key);
  });

  test("returns a structured failure before spawning an OpenRouter child when the key is missing", async () => {
    const cwd = await fakeWorkspace();
    const pidPath = join(cwd, "openrouter-agent.pid");
    const manager = new SubprocessAcpAgentManager(
      openRouterAcpConfig("happy", { FAKE_ACP_PID_FILE: pidPath }),
      { PATH: process.env.PATH ?? "" },
    );
    let startEvents = 0;

    const result = await manager.runAgent(
      agentInput(cwd, { onStarted: () => (startEvents += 1) }),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "OPENROUTER_KEY_MISSING" },
    });
    expect(result.error?.detail).toBeUndefined();
    expect(startEvents).toBe(0);
    expect(existsSync(pidPath)).toBe(false);
  });

  test("keeps a sanitized detail for an unexpected child-environment preflight failure", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("happy"), {});

    const result = await manager.runAgent(agentInput(cwd));

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "AGENT_CONFIG_INVALID",
        detail: "PATH is required to launch ACP child agents.",
      },
    });
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

  test("counts streamed UTF-8 bytes exactly and cancels output above the cap", async () => {
    const cwd = await fakeWorkspace();
    const pidPath = join(cwd, "chunked-agent.pid");
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig("chunked", { FAKE_ACP_PID_FILE: pidPath }),
    );

    const exact = await manager.runAgent(
      agentInput(cwd, { maxOutputBytes: 4 }),
    );
    expect(exact).toMatchObject({
      status: "completed",
      rawText: "あb",
      outputBytes: 4,
      usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8 },
    });

    const over = await manager.runAgent(agentInput(cwd, { maxOutputBytes: 3 }));
    expect(over).toMatchObject({
      status: "failed",
      rawText: "あ",
      outputBytes: 4,
      error: { code: "AGENT_OUTPUT_LIMIT" },
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    await Bun.sleep(1_000);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("counts streamed thought text without retaining it as raw agent output", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig("thought_chunked"),
    );

    const exact = await manager.runAgent(
      agentInput(cwd, { maxOutputBytes: 4 }),
    );
    expect(exact).toMatchObject({
      status: "completed",
      rawText: "b",
      outputBytes: 4,
    });

    const over = await manager.runAgent(agentInput(cwd, { maxOutputBytes: 3 }));
    expect(over).toMatchObject({
      status: "failed",
      rawText: "",
      outputBytes: 4,
      error: { code: "AGENT_OUTPUT_LIMIT" },
    });
  });

  test("classifies immediate ACP child crashes from stderr", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("crash"));
    let startEvents = 0;

    const result = await manager.runAgent(
      agentInput(cwd, { onStarted: () => (startEvents += 1) }),
    );

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AUTH_FAILED");
    expect(result.error?.message).toContain("authentication failed");
    expect(result.error?.detail).toContain("auth failed");
    expect(startEvents).toBe(1);
  });

  test("does not relabel an unexpected launch error as a preflight failure", async () => {
    const cwd = await fakeWorkspace();
    const config = fakeAcpConfig("happy");
    const manager = new SubprocessAcpAgentManager({
      ...config,
      agents: {
        ...config.agents,
        codex: {
          ...config.agents.codex,
          args: ["\0"],
        },
      },
    });
    let startEvents = 0;

    const result = await manager.runAgent(
      agentInput(cwd, { onStarted: () => (startEvents += 1) }),
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "AGENT_FAILED" },
    });
    expect(result.error?.code).not.toBe("AGENT_CONFIG_INVALID");
    expect(startEvents).toBe(0);
  });

  test("forwards codex effort as reasoning_effort before prompting", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig("happy", {}, { effort: "high" }),
    );

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).toContain(
      "configOption=reasoning_effort:high",
    );
  });

  test("forwards claude effort as effort before prompting", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig("happy", {}, { agent: "claude", effort: "high" }),
    );

    const result = await manager.runAgent(agentInput(cwd, { agent: "claude" }));

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).toContain("configOption=effort:high");
  });

  test("does not send a session config option when effort is not configured", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(fakeAcpConfig("happy"));

    const result = await manager.runAgent(agentInput(cwd));

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).not.toContain("configOption=");
  });

  test("keeps the session running when the agent rejects the config option", async () => {
    const cwd = await fakeWorkspace();
    const manager = new SubprocessAcpAgentManager(
      fakeAcpConfig(
        "happy",
        { FAKE_ACP_REJECT_CONFIG_OPTION: "1" },
        { effort: "high" },
      ),
    );
    const originalError = console.error;
    const errorCalls: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorCalls.push(args);
    };

    let result: Awaited<ReturnType<typeof manager.runAgent>>;
    try {
      result = await manager.runAgent(agentInput(cwd));
    } finally {
      console.error = originalError;
    }

    expect(result.status).toBe("completed");
    expect(result.normalized?.summary).not.toContain("configOption=");
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0]?.[0]).toContain("configId=reasoning_effort");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("configId=reasoning_effort");
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

type FakeAcpMode =
  "happy" | "garbage" | "crash" | "hang" | "chunked" | "thought_chunked";

function fakeAcpConfig(
  mode: FakeAcpMode,
  env: Record<string, string> = {},
  options: { agent?: AgentName; effort?: string } = {},
): KyosoConfig {
  const baseConfig = kyosoConfigSchema.parse(defaultConfig);
  const targetAgent = options.agent ?? "codex";
  const otherAgent: AgentName = targetAgent === "codex" ? "claude" : "codex";
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      [targetAgent]: {
        ...baseConfig.agents[targetAgent],
        command: "bun",
        args: ["run", join(process.cwd(), "test/fixtures/fake-acp-agent.ts")],
        env: {
          ...baseConfig.agents[targetAgent].env,
          FAKE_ACP_MODE: mode,
          ...env,
        },
        ...(options.effort ? { effort: options.effort } : {}),
      },
      [otherAgent]: {
        ...baseConfig.agents[otherAgent],
        enabled: false,
      },
    },
  };
}

function openRouterAcpConfig(
  mode: FakeAcpMode,
  env: Record<string, string> = {},
): KyosoConfig {
  const baseConfig = fakeAcpConfig(mode, env);
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      codex: {
        ...baseConfig.agents.codex,
        provider: "openrouter",
        model: "openai/o4-mini",
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

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}
