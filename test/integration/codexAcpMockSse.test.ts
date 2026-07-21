import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessAcpAgentManager } from "../../src/acp/AcpAgentProcess.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  kyosoConfigSchema,
  type KyosoConfig,
} from "../../src/config/schema.js";
import type {
  AgentProgressEvent,
  AgentRunInput,
  AgentRunResult,
} from "../../src/core/types.js";
import {
  startMockResponsesServer,
  type MockAttemptScript,
} from "../fixtures/mockResponsesServer.js";

const enabled = process.env.KYOSO_CODEX_ACP_MOCK_SSE === "1";
const testIf = enabled ? test : test.skip;

const validOpinion = {
  summary: "mock Responses SSE completed",
  findings: [
    {
      severity: "low",
      category: "test",
      title: "Mock Responses SSE finding",
      evidence: "the Codex ACP adapter received the complete mock response",
      recommendation: "retain the mock SSE integration gate",
      confidence: "high",
    },
  ],
  testsToAdd: ["mock Responses SSE regression test"],
  residualRisks: [],
  openQuestions: [],
};
const validOpinionText = JSON.stringify(validOpinion);

describe("Codex ACP mock Responses SSE integration", () => {
  testIf(
    "completes one real Codex ACP request against a complete Responses stream",
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "kyoso-codex-acp-sse-"));
      const logDir = join(tempDir, "app-server-logs");
      const mock = await startMockResponsesServer([
        { kind: "complete", text: validOpinionText },
      ]);
      try {
        await mkdir(join(tempDir, "codex-home"), { recursive: true });
        const manager = new SubprocessAcpAgentManager(
          mockSseConfig(logDir),
          mockSseParentEnv(tempDir),
          { openRouterBaseUrlForTest: mock.baseUrl },
        );
        const result = await manager.runAgent(agentInput(tempDir));

        if (result.status !== "completed") {
          throw new Error(
            `Codex ACP mock SSE happy path failed: ${JSON.stringify({
              result,
              appServerLog: await readAppServerLog(logDir),
            })}`,
          );
        }
        if (mock.requests.length !== 1) {
          throw new Error(
            `Codex ACP mock SSE expected one request: ${JSON.stringify({
              requests: mock.requests,
              appServerLog: await readAppServerLog(logDir),
              result,
            })}`,
          );
        }
        expect(result.rawText).toBe(validOpinionText);
      } finally {
        await mock.close();
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  testIf(
    "retries an early stream close in the same ACP session",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "early_close" },
          { kind: "complete", text: validOpinionText },
        ],
        openRouter: retryPolicy(),
      });

      expectCompleted("early close", scenario);
      expect(scenario.requests).toHaveLength(2);
      expect(scenario.result.rawText).toBe(validOpinionText);
      expectObservedRetries(scenario, 1);
    },
    60_000,
  );

  testIf(
    "discards partial output before a stream retry",
    async () => {
      const partialText = '{"summary":"par';
      const scenario = await runMockSseScenario({
        script: [
          { kind: "partial_then_close", partialText },
          { kind: "complete", text: validOpinionText },
        ],
        openRouter: retryPolicy(),
      });

      expectCompleted("partial stream close", scenario);
      expect(scenario.requests).toHaveLength(2);
      expect(scenario.result.rawText).not.toContain(partialText);
      expect(scenario.result.discardedRetryMessageBytes).toBe(
        Buffer.byteLength(partialText, "utf8"),
      );
      expect(scenario.result.normalized?.summary).toBe(validOpinion.summary);
      expectObservedRetries(scenario, 1);
    },
    60_000,
  );

  testIf(
    "retries a truly idle stream after the configured timeout",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "idle_forever" },
          { kind: "complete", text: validOpinionText },
        ],
        openRouter: retryPolicy({ streamMaxRetries: 1 }),
      });

      expectCompleted("idle stream", scenario);
      expect(scenario.requests).toHaveLength(2);
      expectRequestDelayAtLeast(scenario, 850);
      expectObservedRetries(scenario, 1);
    },
    60_000,
  );

  testIf(
    "does not treat comment heartbeats as stream activity",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "comment_heartbeat", intervalMs: 200 },
          { kind: "complete", text: validOpinionText },
        ],
        openRouter: retryPolicy({ streamMaxRetries: 1 }),
      });

      expectCompleted("comment heartbeat", scenario);
      expect(scenario.requests).toHaveLength(2);
      expectObservedRetries(scenario, 1);
    },
    60_000,
  );

  testIf(
    "keeps a valid data drip alive until Kyoso times out",
    async () => {
      const scenario = await runMockSseScenario({
        script: [{ kind: "data_drip", intervalMs: 200 }],
        openRouter: retryPolicy({ streamMaxRetries: 1 }),
        timeoutMs: 8_000,
      });

      if (scenario.result.status !== "timeout") {
        throw scenarioFailure("data drip", scenario);
      }
      expect(scenario.result.error?.code).toBe("AGENT_TIMEOUT");
      expect(scenario.requests).toHaveLength(1);
    },
    20_000,
  );

  testIf(
    "retries a retryable failed response",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "failed_retryable" },
          { kind: "complete", text: validOpinionText },
        ],
        openRouter: retryPolicy(),
      });

      expectCompleted("retryable failed response", scenario);
      expect(scenario.requests).toHaveLength(2);
      expectObservedRetries(scenario, 1);
    },
    60_000,
  );

  testIf(
    "retries an HTTP 401 until stream retry exhaustion",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "error_401" },
          { kind: "error_401" },
          { kind: "error_401" },
        ],
        openRouter: retryPolicy({ streamMaxRetries: 2 }),
      });

      if (scenario.result.status !== "failed") {
        throw scenarioFailure("HTTP 401 retry exhaustion", scenario);
      }
      expect(scenario.requests).toHaveLength(3);
      expectObservedRetries(scenario, 2);
    },
    60_000,
  );

  testIf(
    "fails after exhausting the configured stream retries",
    async () => {
      const scenario = await runMockSseScenario({
        script: [
          { kind: "early_close" },
          { kind: "early_close" },
          { kind: "early_close" },
        ],
        openRouter: retryPolicy({ streamMaxRetries: 2 }),
      });

      if (scenario.result.status !== "failed") {
        throw scenarioFailure("retry exhaustion", scenario);
      }
      expect(scenario.requests).toHaveLength(3);
      expect(scenario.result.error?.code).not.toBe("AGENT_TIMEOUT");
      expectObservedRetries(scenario, 2);
    },
    60_000,
  );
});

type MockSseScenario = {
  result: AgentRunResult;
  requests: Array<{ at: number; body: unknown }>;
  progress: AgentProgressEvent[];
  appServerLog?: string;
};

type MockSseScenarioOptions = {
  script: MockAttemptScript[];
  openRouter: KyosoConfig["agents"]["codex"]["openRouter"];
  timeoutMs?: number;
};

async function runMockSseScenario(
  options: MockSseScenarioOptions,
): Promise<MockSseScenario> {
  const tempDir = await mkdtemp(join(tmpdir(), "kyoso-codex-acp-sse-"));
  const logDir = join(tempDir, "app-server-logs");
  let mock: Awaited<ReturnType<typeof startMockResponsesServer>> | undefined;
  try {
    mock = await startMockResponsesServer(options.script);
    await mkdir(join(tempDir, "codex-home"), { recursive: true });
    const progress: AgentProgressEvent[] = [];
    const manager = new SubprocessAcpAgentManager(
      mockSseConfig(logDir, options.openRouter),
      mockSseParentEnv(tempDir),
      { openRouterBaseUrlForTest: mock.baseUrl },
    );
    const result = await manager.runAgent(
      agentInput(tempDir, options.timeoutMs, (event) => progress.push(event)),
    );
    return {
      result,
      requests: [...mock.requests],
      progress,
      appServerLog: await readAppServerLog(logDir),
    };
  } finally {
    await mock?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

function expectCompleted(label: string, scenario: MockSseScenario): void {
  if (scenario.result.status !== "completed") {
    throw scenarioFailure(label, scenario);
  }
}

function expectObservedRetries(
  scenario: MockSseScenario,
  expected: number,
): void {
  expect(scenario.result.observedStreamRetries).toBe(expected);
  expect(
    scenario.progress.filter(
      (
        event,
      ): event is Extract<AgentProgressEvent, { type: "agent_retrying" }> =>
        event.type === "agent_retrying",
    ),
  ).toHaveLength(expected);
}

function expectRequestDelayAtLeast(
  scenario: MockSseScenario,
  minimumMs: number,
): void {
  const first = scenario.requests[0];
  const second = scenario.requests[1];
  if (!first || !second) throw scenarioFailure("request timing", scenario);
  expect(second.at - first.at).toBeGreaterThanOrEqual(minimumMs);
}

function scenarioFailure(label: string, scenario: MockSseScenario): Error {
  const diagnostic = {
    ...scenario,
    requests: scenario.requests.map(({ at }) => ({ at })),
  };
  return new Error(
    `Codex ACP mock SSE ${label} failed: ${JSON.stringify(diagnostic)}`,
  );
}

function retryPolicy(
  overrides: Partial<KyosoConfig["agents"]["codex"]["openRouter"]> = {},
): KyosoConfig["agents"]["codex"]["openRouter"] {
  return {
    streamIdleTimeoutMs: 1_000,
    streamMaxRetries: 2,
    requestMaxRetries: 1,
    ...overrides,
  };
}

function mockSseParentEnv(tempDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    CODEX_HOME: join(tempDir, "codex-home"),
    OPENROUTER_API_KEY: "dummy-key",
  };
}

function mockSseConfig(
  appServerLogDir: string,
  openRouter: KyosoConfig["agents"]["codex"]["openRouter"] = {},
): KyosoConfig {
  const baseConfig = kyosoConfigSchema.parse(defaultConfig);
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      codex: {
        ...baseConfig.agents.codex,
        provider: "openrouter",
        model: "openai/gpt-5.4",
        env: {
          ...baseConfig.agents.codex.env,
          APP_SERVER_LOGS: appServerLogDir,
          DEFAULT_AUTH_REQUEST: JSON.stringify({
            methodId: "api-key",
            _meta: { "api-key": { apiKey: "dummy-key" } },
          }),
        },
        openRouter,
      },
      claude: {
        ...baseConfig.agents.claude,
        enabled: false,
      },
    },
  };
}

function agentInput(
  workspaceDir: string,
  timeoutMs = 60_000,
  onProgress?: (event: AgentProgressEvent) => void,
): AgentRunInput {
  return {
    traceId: "tr_codex_acp_mock_sse",
    agent: "codex",
    role: "combined_reviewer",
    tool: "diff_review",
    prompt: "Return the supplied JSON opinion without tools or commentary.",
    workspaceDir,
    timeoutMs,
    networkMode: "model_only",
    onProgress,
  };
}

async function readAppServerLog(logDir: string): Promise<string | undefined> {
  try {
    const contents = await readFile(join(logDir, "app-server.log"), "utf8");
    const maximumLength = 8_000;
    return contents.length <= maximumLength
      ? contents
      : `...[truncated ${contents.length - maximumLength} characters]\n${contents.slice(-maximumLength)}`;
  } catch {
    return undefined;
  }
}
