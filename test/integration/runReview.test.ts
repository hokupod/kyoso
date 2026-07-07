import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubprocessAcpAgentManager } from "../../src/acp/AcpAgentProcess.js";
import {
  FakeAgentManager,
  type FakeAgentScenario,
} from "../../src/acp/FakeAgentManager.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  type KyosoConfig,
  kyosoConfigSchema,
} from "../../src/config/schema.js";
import { runReview } from "../../src/core/runReview.js";

const originalJudgeEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CODEX_API_KEY: process.env.CODEX_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
};

beforeAll(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterAll(() => {
  restoreEnv("OPENAI_API_KEY", originalJudgeEnv.OPENAI_API_KEY);
  restoreEnv("CODEX_API_KEY", originalJudgeEnv.CODEX_API_KEY);
  restoreEnv("ANTHROPIC_API_KEY", originalJudgeEnv.ANTHROPIC_API_KEY);
  restoreEnv(
    "CLAUDE_CODE_OAUTH_TOKEN",
    originalJudgeEnv.CLAUDE_CODE_OAUTH_TOKEN,
  );
});

describe("runReview", () => {
  test("secret detection blocks before agents run", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "security_review",
      {
        goal: "review",
        selectedFiles: [
          {
            path: "src/config.ts",
            content:
              "export const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';",
          },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );
    expect(result.decision).toBe("block");
    expect(result.findings[0]?.category).toBe("secret");
    expect(manager.calls).toHaveLength(0);
  });

  test("secret detection blocks token-like selected file paths before agents run", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const leaked = `sk-${"proj"}-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const result = await runReview(
      "plan_review",
      {
        goal: "review",
        selectedFiles: [
          { path: `src/${leaked}.ts`, content: "export const value = 1;" },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );

    expect(result.decision).toBe("block");
    expect(manager.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(result.findings[0]?.evidence).toContain("selectedFiles[0].path");
  });

  test("allowed secret redaction still records a secret finding and CISA signal", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "security_review",
      {
        goal: "review",
        constraints: ["api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
        options: { allowSecretRedaction: true },
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );
    const secretFinding = result.findings.find(
      (finding) => finding.category === "secret",
    );

    expect(manager.calls).toHaveLength(2);
    expect(result.audit.redactionsApplied).toBe(1);
    expect(secretFinding?.title).toContain("redacted");
    expect(result.cisaSecureByDesign?.customerSecurityOutcomes).toBe("warn");
    expect(result.decision).toBe("approve_with_changes");
  });

  test("allowed secret redaction removes credential file contents before prompting agents", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      workspace: { ...baseConfig.workspace, deny: [] },
    };
    const result = await runReview(
      "plan_review",
      {
        goal: "review",
        selectedFiles: [
          { path: ".env/production", content: "PASSWORD=local-dev-password" },
        ],
        options: { allowSecretRedaction: true },
      },
      { cwd, config, agentManager: manager },
    );

    expect(manager.calls).toHaveLength(2);
    expect(manager.calls[0]?.prompt).not.toContain("local-dev-password");
    expect(manager.calls[0]?.prompt).toContain("[KYOSO_REDACTED]");
    expect(result.audit.redactionsApplied).toBe(1);
  });

  test("workspace deny patterns keep selected files out of child prompts", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        selectedFiles: [
          {
            path: "packages/app/.codex/config.toml",
            content: "mcp_servers = ['kyoso']",
          },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );
    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).not.toContain("mcp_servers");
    expect(result.audit.warnings?.join("\n")).toContain("Selected file denied");
  });

  test("request workspace denyRead keeps selected files out of child prompts", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        workspace: { denyRead: ["src/secret.ts"] },
        selectedFiles: [
          { path: "src/secret.ts", content: "const hidden = 1;" },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );

    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).not.toContain("const hidden = 1");
    expect(result.audit.warnings?.join("\n")).toContain("Selected file denied");
  });

  test("request workspace allowRead keeps non-allowed selected files out of child prompts", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        workspace: { allowRead: ["src/public.ts"] },
        selectedFiles: [
          { path: "src/public.ts", content: "export const visible = 1;" },
          { path: "src/secret.ts", content: "const hidden = 1;" },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );

    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).toContain("export const visible = 1");
    expect(manager.calls[0]?.prompt).not.toContain("const hidden = 1");
    expect(result.audit.warnings?.join("\n")).toContain(
      "outside workspace allow policy",
    );
  });

  test("request workspace allowRead anchors single-segment paths at workspace root", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        workspace: { allowRead: ["src"] },
        selectedFiles: [
          { path: "src/public.ts", content: "export const visible = 1;" },
          { path: "packages/app/src/secret.ts", content: "const hidden = 1;" },
        ],
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );

    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).toContain("export const visible = 1");
    expect(manager.calls[0]?.prompt).not.toContain("const hidden = 1");
    expect(result.audit.warnings?.join("\n")).toContain(
      "outside workspace allow policy",
    );
  });

  test("untrusted request workspace root is rejected before agents run", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();

    await expect(
      runReview(
        "plan_review",
        {
          goal: "review plan",
          workspace: { root: "../untrusted" },
          selectedFiles: [
            { path: "src/public.ts", content: "export const visible = 1;" },
          ],
        },
        {
          cwd,
          config: kyosoConfigSchema.parse(defaultConfig),
          agentManager: manager,
        },
      ),
    ).rejects.toThrow("workspace.root is not trusted");
    expect(manager.calls).toHaveLength(0);
  });

  test("MCP network cap rejects unrestricted requests before agents run", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();

    await expect(
      runReview(
        "plan_review",
        {
          goal: "review plan",
          options: { network: "unrestricted" },
        },
        {
          cwd,
          config: kyosoConfigSchema.parse(defaultConfig),
          agentManager: manager,
          mcpNetworkMode: "model_only",
        },
      ),
    ).rejects.toThrow("MCP --network model_only");
    expect(manager.calls).toHaveLength(0);
  });

  test("MCP unrestricted cap does not become the default request network mode", async () => {
    const cwd = await tempCwd();
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
        mcpNetworkMode: "unrestricted",
      },
    );

    expect(result.audit.networkMode).toBe("model_only");
    expect(manager.calls[0]?.networkMode).toBe("model_only");
  });

  test("claude-only review runs once with combined role and marks single-agent output", async () => {
    const cwd = await tempCwd();
    const config = singleAgentConfig("claude");
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      { cwd, config, agentManager: manager },
    );
    const traceEvents = await readTraceEvents(cwd, config, result);
    const started = traceEvents.find((event) => event.type === "agent_started");

    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.agent).toBe("claude");
    expect(manager.calls[0]?.role).toBe("combined_reviewer");
    expect(manager.calls[0]?.prompt).toContain("combined reviewer role");
    expect(manager.calls[0]?.prompt).toContain("feasibility");
    expect(manager.calls[0]?.prompt).toContain("threat modeling");
    expect(result.reviewMode).toBe("single_agent");
    expect(result.agentsUsed).toEqual(["claude"]);
    expect(result.audit.agentsUsed).toEqual(["claude"]);
    expect(result.agentOpinions[0]?.role).toBe("combined_reviewer");
    expect(result.disagreements).toEqual([]);
    expect(result.summaryMarkdown).toContain("single-agent");
    expect(result.summaryMarkdown).toContain("cross-model verification");
    expect(result.summaryMarkdown).toContain("N/A - single-agent review");
    expect(started?.role).toBe("combined_reviewer");
  });

  test("codex-only review is symmetric with combined role", async () => {
    const cwd = await tempCwd();
    const config = singleAgentConfig("codex");
    const manager = new FakeAgentManager();
    const result = await runReview(
      "diff_review",
      {
        goal: "review diff",
        diff: {
          unifiedDiff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n",
        },
      },
      { cwd, config, agentManager: manager },
    );

    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.agent).toBe("codex");
    expect(manager.calls[0]?.role).toBe("combined_reviewer");
    expect(result.reviewMode).toBe("single_agent");
    expect(result.agentsUsed).toEqual(["codex"]);
    expect(result.audit.agentsUsed).toEqual(["codex"]);
    expect(result.agentOpinions[0]?.role).toBe("combined_reviewer");
    expect(result.summaryMarkdown).toContain("N/A - single-agent review");
  });

  test("two-agent review keeps configured roles and multi-agent mode", async () => {
    const cwd = await tempCwd();
    const config = kyosoConfigSchema.parse(defaultConfig);
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      { cwd, config, agentManager: manager },
    );

    expect(manager.calls.map((call) => call.role)).toEqual([
      "implementation_reviewer",
      "architecture_security_reviewer",
    ]);
    expect(result.reviewMode).toBe("multi_agent");
    expect(result.agentsUsed).toEqual(["codex", "claude"]);
    expect(result.summaryMarkdown).toContain("**Review mode:** multi-agent");
    expect(result.summaryMarkdown).toContain("- None.");
    expect(result.summaryMarkdown).not.toContain("N/A - single-agent review");
  });

  test("untrusted local config is skipped and reported in result warnings", async () => {
    const cwd = await tempCwd();
    await writeFile(
      join(cwd, "kyoso.config.ts"),
      `throw new Error("config should not execute without trust");
export default {};
`,
      "utf8",
    );
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd,
        trustStorePath: join(cwd, "trusted-configs.json"),
        agentManager: manager,
      },
    );

    expect(result.audit.networkMode).toBe("model_only");
    expect(result.audit.warnings?.join("\n")).toContain(
      "untrusted config was not executed",
    );
    expect(manager.calls).toHaveLength(2);

    const config = kyosoConfigSchema.parse(defaultConfig);
    const traceText = await readFile(
      join(
        cwd,
        config.audit.directory,
        result.audit.startedAt.slice(0, 10),
        `${result.audit.traceId}.jsonl`,
      ),
      "utf8",
    );
    expect(traceText).toContain('"configTrustStatus":"untrusted_skipped"');
  });

  test("security review includes CISA gate and tests", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "security_review",
      { goal: "review auth", repoSummary: "auth module" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager(),
      },
    );
    expect(result.cisaSecureByDesign?.governance).toBe("warn");
    expect(result.testsToAdd.length).toBeGreaterThan(0);
    expect(result.residualRisks.length).toBeGreaterThan(0);
    expect(result.summaryMarkdown).toContain("CISA Secure by Design Gate");
    expect(result.summaryMarkdown).toContain("Residual Risks");
  });

  test("raw agent JSON CISA gate participates in decision", async () => {
    const cwd = await tempCwd();
    const rawText = JSON.stringify({
      summary: "raw cisa failure",
      findings: [],
      testsToAdd: ["raw agent security test"],
      residualRisks: ["raw agent residual risk"],
      openQuestions: [],
      cisaSecureByDesign: {
        customerSecurityOutcomes: "fail",
        notes: ["raw agent reported a CISA failure"],
      },
    });
    const manager = rawTextAgentManager(rawText);

    const result = await runReview(
      "security_review",
      { goal: "review auth", repoSummary: "auth module" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: manager,
      },
    );

    expect(result.decision).toBe("block");
    expect(result.cisaSecureByDesign?.customerSecurityOutcomes).toBe("fail");
    expect(result.testsToAdd).toContain("raw agent security test");
    expect(result.residualRisks).toContain("raw agent residual risk");
    expect(result.agentOpinions[0]?.summary).toBe("raw cisa failure");
  });

  test("judge can rewrite only summary text without mutating the rendered report or seeing raw agent output", async () => {
    const cwd = await tempCwd();
    const rawOnlyMarker = "RAW_AGENT_ONLY_MARKER";
    const rawText = `${JSON.stringify({
      summary: "agent summary",
      findings: [
        {
          severity: "critical",
          category: "authz",
          title: "Tenant boundary bypass",
          evidence: "tenant id is trusted from client input",
          recommendation: "derive tenant id from the authenticated session",
          confidence: "high",
        },
      ],
      testsToAdd: [],
      residualRisks: [],
      openQuestions: [],
    })}\n${rawOnlyMarker}`;
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      judge: { ...baseConfig.judge, provider: "openai", timeoutMs: 1_000 },
    };
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summaryText: "Judge rewritten summary",
                  decision: "approve",
                  findings: [],
                  disagreementComments: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await runReview(
        "plan_review",
        { goal: "review plan" },
        {
          cwd,
          config,
          agentManager: rawTextAgentManager(rawText),
          env: { OPENAI_API_KEY: "test-key" },
        },
      );

      expect(result.summaryMarkdown).toContain("# Kyoso Review Result");
      expect(result.summaryMarkdown).toContain("**Decision:** block");
      expect(result.summaryMarkdown).toContain("## Findings");
      expect(result.summaryMarkdown).toContain("Judge rewritten summary");
      expect(result.decision).toBe("block");
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.title).toBe("Tenant boundary bypass");
      expect(requestBody).not.toContain(rawOnlyMarker);
      expect(requestBody).not.toContain("summaryMarkdown");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("raw agent output is returned only when requested and remains sanitized", async () => {
    const cwd = await tempCwd();
    const leaked = `sk-proj-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const rawText = `{
  "summary": "summary ${leaked}",
  "findings": [],
  "testsToAdd": [],
  "residualRisks": [],
  "openQuestions": []
}`;

    const withoutRaw = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: rawTextAgentManager(rawText),
      },
    );
    const withRaw = await runReview(
      "plan_review",
      {
        goal: "review plan",
        options: { includeAgentRawOutputs: true },
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: rawTextAgentManager(rawText),
      },
    );

    expect(withoutRaw.agentOpinions[0]?.rawText).toBeUndefined();
    expect(withRaw.agentOpinions[0]?.rawText).toContain("[KYOSO_REDACTED]");
    expect(withRaw.agentOpinions[0]?.rawText).toContain('\n  "findings"');
    expect(JSON.stringify(withRaw)).not.toContain(leaked);
  });

  test("judge prompt excludes raw agent output even when result raw output is requested", async () => {
    const cwd = await tempCwd();
    const rawOnlyMarker = "RAW_AGENT_ONLY_MARKER";
    const rawText = JSON.stringify({
      summary: "agent summary",
      findings: [],
      testsToAdd: [],
      residualRisks: [],
      openQuestions: [],
      rawOnlyMarker,
    });
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      judge: { ...baseConfig.judge, provider: "openai", timeoutMs: 1_000 },
    };
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = (async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summaryText: "Judge summary",
                  disagreementComments: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await runReview(
        "plan_review",
        {
          goal: "review plan",
          options: { includeAgentRawOutputs: true },
        },
        {
          cwd,
          config,
          agentManager: rawTextAgentManager(rawText),
          env: { OPENAI_API_KEY: "test-key" },
        },
      );

      expect(result.agentOpinions[0]?.rawText).toContain(rawOnlyMarker);
      expect(requestBody).not.toContain(rawOnlyMarker);
      expect(requestBody).not.toContain("rawText");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("audit trace includes sanitized raw agent output only when configured", async () => {
    const cwd = await tempCwd();
    const leaked = `sk-proj-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const rawText = `{
  "summary": "summary ${leaked}",
  "findings": [],
  "testsToAdd": [],
  "residualRisks": [],
  "openQuestions": []
}`;
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      audit: { ...baseConfig.audit, includeRawAgentOutput: true },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd,
        config,
        agentManager: rawTextAgentManager(rawText),
      },
    );
    const traceText = await readFile(
      join(
        cwd,
        config.audit.directory,
        result.audit.startedAt.slice(0, 10),
        `${result.audit.traceId}.jsonl`,
      ),
      "utf8",
    );

    expect(traceText).toContain('"rawText"');
    expect(traceText).toContain("[KYOSO_REDACTED]");
    expect(traceText).not.toContain(leaked);

    const lines = traceText.trimEnd().split("\n");
    const events = lines.map((line) => JSON.parse(line) as { type?: string });
    const rawEventLines = lines.filter((line) =>
      line.includes('"type":"agent_completed"'),
    );

    expect(
      events.filter((event) => event.type === "agent_completed"),
    ).toHaveLength(2);
    expect(rawEventLines).toHaveLength(2);
    expect(
      rawEventLines.every((line) => line.includes('\\n  \\"findings\\"')),
    ).toBe(true);
  });

  test("agent failure audit includes sanitized details and run timestamps", async () => {
    const cwd = await tempCwd();
    const leaked = `sk-ant-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const errorDetail = `Internal error; data: {"details":"Not initialized","token":"${leaked}"}`;
    const config = kyosoConfigSchema.parse(defaultConfig);
    const result = await runReview(
      "plan_review",
      { goal: "review plan" },
      {
        cwd,
        config,
        agentManager: failedAgentManager(errorDetail),
      },
    );
    const traceText = await readFile(
      join(
        cwd,
        config.audit.directory,
        result.audit.startedAt.slice(0, 10),
        `${result.audit.traceId}.jsonl`,
      ),
      "utf8",
    );

    const events = traceText
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const agentEvents = events.filter(
      (event) => event.type === "agent_completed",
    );

    expect(agentEvents).toHaveLength(2);
    expect(
      agentEvents.every(
        (event) =>
          event.errorCode === "AGENT_FAILED" &&
          typeof event.errorDetail === "string" &&
          typeof event.startedAt === "string" &&
          typeof event.completedAt === "string",
      ),
    ).toBe(true);
    expect(traceText).toContain("Not initialized");
    expect(traceText).toContain("[KYOSO_REDACTED]");
    expect(traceText).not.toContain(leaked);
  });

  test("fake ACP markdown JSON output is normalized by the core pipeline", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({
          codex: "markdown_json",
          claude: "markdown_json",
        }),
      },
    );

    expect(result.decision).toBe("approve");
    expect(result.agentOpinions.map((opinion) => opinion.summary)).toEqual([
      "codex reviewed plan_review",
      "claude reviewed plan_review",
    ]);
    expect(result.testsToAdd).toContain(
      "codex: add regression coverage for plan_review",
    );
    expect(result.testsToAdd).toContain(
      "claude: add regression coverage for plan_review",
    );
  });

  test("fake ACP malformed output remains a structured parse finding", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({ codex: "malformed" }),
      },
    );

    expect(result.degraded).toBe(false);
    expect(
      result.findings.some(
        (finding) => finding.title === "Agent output could not be parsed",
      ),
    ).toBe(true);
    expect(
      result.agentOpinions.find((opinion) => opinion.agent === "codex")
        ?.summary,
    ).toContain("No JSON object found");
  });

  test("one backend timeout returns degraded result", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "diff_review",
      {
        goal: "review diff",
        diff: {
          unifiedDiff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n",
        },
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({ claude: "timeout" }),
      },
    );
    expect(result.degraded).toBe(true);
    expect(
      result.agentOpinions.find((opinion) => opinion.agent === "claude")
        ?.status,
    ).toBe("timeout");
  });

  test("fake ACP policy and auth failures stay degraded with explicit error codes", async () => {
    const scenarios: Array<{ scenario: FakeAgentScenario; code: string }> = [
      { scenario: "auth_failure", code: "AUTH_FAILED" },
      { scenario: "permission_request", code: "PERMISSION_DENIED" },
      { scenario: "write_attempt", code: "WRITE_ATTEMPT_DENIED" },
    ];

    for (const { scenario, code } of scenarios) {
      const cwd = await tempCwd();
      const result = await runReview(
        "plan_review",
        { goal: `review ${scenario}`, currentPlan: "do it" },
        {
          cwd,
          config: kyosoConfigSchema.parse(defaultConfig),
          agentManager: new FakeAgentManager({ codex: scenario }),
        },
      );

      expect(result.degraded).toBe(true);
      expect(result.decision).toBe("approve");
      expect(
        result.agentOpinions.find((opinion) => opinion.agent === "codex")
          ?.errorCode,
      ).toBe(code);
    }
  });

  test("both backend failures produce structured block", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({
          codex: "auth_failure",
          claude: "timeout",
        }),
      },
    );
    expect(result.decision).toBe("block");
    expect(
      result.findings.some(
        (finding) => finding.title === "All backend agents failed",
      ),
    ).toBe(true);
  });

  test("recursion guard blocks child invocation", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager(),
        env: { KYOSO_CHILD_AGENT: "1" },
      },
    );
    expect(result.decision).toBe("block");
    expect(result.findings[0]?.title).toContain("Recursive");
  });

  test("security policy blocks include tests and residual risks", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "security_review",
      { goal: "review security" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager(),
        env: { KYOSO_CHILD_AGENT: "1" },
      },
    );

    expect(result.decision).toBe("block");
    expect(result.cisaSecureByDesign).toBeDefined();
    expect(result.testsToAdd.length).toBeGreaterThan(0);
    expect(result.residualRisks.length).toBeGreaterThan(0);
  });

  test("recursion guard blocks before loading local config", async () => {
    const cwd = await tempCwd();
    await writeFile(
      join(cwd, "kyoso.config.ts"),
      `throw new Error("config should not load when recursion guard is active");
export default {};
`,
      "utf8",
    );
    const manager = new FakeAgentManager();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        agentManager: manager,
        env: { KYOSO_CHILD_AGENT: "1" },
      },
    );

    expect(result.decision).toBe("block");
    expect(result.findings[0]?.title).toContain("Recursive");
    expect(manager.calls).toHaveLength(0);
  });

  test("subprocess ACP manager speaks ACP to a backend adapter", async () => {
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      agents: {
        codex: {
          ...baseConfig.agents.codex,
          command: "bun",
          args: ["run", join(process.cwd(), "test/fixtures/fake-acp-agent.ts")],
        },
        claude: {
          ...baseConfig.agents.claude,
          enabled: false,
        },
      },
    };
    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        currentPlan: "do it",
        selectedFiles: [
          { path: "src/foo.ts", content: "export const foo = 1;" },
        ],
        options: { maxAgentTimeoutMs: 5_000 },
      },
      {
        cwd: process.cwd(),
        config,
        agentManager: new SubprocessAcpAgentManager(config),
      },
    );
    expect(result.decision).toBe("approve");
    expect(result.agentOpinions[0]?.summary).toContain(
      "read snapshot context and selected file",
    );
    expect(result.testsToAdd).toContain("fake ACP subprocess test");
    expect(result.residualRisks).toContain("fake ACP subprocess residual risk");
  });

  test("subprocess timeout escalates from SIGTERM to SIGKILL", async () => {
    const cwd = await tempCwd();
    const scriptPath = join(cwd, "ignore-term.js");
    const pidPath = join(cwd, "pid.txt");
    await writeFile(
      scriptPath,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      agents: {
        codex: {
          ...baseConfig.agents.codex,
          command: "bun",
          args: [scriptPath],
        },
        claude: {
          ...baseConfig.agents.claude,
          enabled: false,
        },
      },
    };

    const result = await runReview(
      "plan_review",
      { goal: "review plan", options: { maxAgentTimeoutMs: 100 } },
      {
        cwd,
        config,
        agentManager: new SubprocessAcpAgentManager(config),
      },
    );
    const pid = Number(await readFile(pidPath, "utf8"));

    expect(result.agentOpinions[0]?.status).toBe("timeout");
    await Bun.sleep(2_500);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("subprocess ACP failures do not expose raw stderr secrets", async () => {
    const cwd = await tempCwd();
    const leaked = `sk-proj-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const scriptPath = join(cwd, "failing-agent.js");
    await writeFile(
      scriptPath,
      `console.error("auth failed api_key=" + "sk-proj-" + "abcdefghijklmnopqrstuvwxyz123456");
process.exit(1);
`,
      "utf8",
    );
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      agents: {
        codex: {
          ...baseConfig.agents.codex,
          command: "bun",
          args: [scriptPath],
        },
        claude: {
          ...baseConfig.agents.claude,
          enabled: false,
        },
      },
    };

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        currentPlan: "do it",
        options: { maxAgentTimeoutMs: 5_000 },
      },
      {
        cwd,
        config,
        agentManager: new SubprocessAcpAgentManager(config),
      },
    );
    const serialized = JSON.stringify(result);

    expect(result.agentOpinions[0]?.errorCode).toBe("AUTH_FAILED");
    expect(result.agentOpinions[0]?.summary).toBe(
      "Agent authentication failed. Run kyoso doctor and check configured credentials.",
    );
    expect(serialized).not.toContain(leaked);
    expect(result.summaryMarkdown).not.toContain("api_key");
  });

  test("subprocess npm network failures are not classified as permission denials", async () => {
    const cwd = await tempCwd();
    const scriptPath = join(cwd, "network-failing-agent.js");
    await writeFile(
      scriptPath,
      `console.error("npm error code ENOTFOUND");
console.error("npm error network request to https://registry.npmjs.org/@agentclientprotocol%2fcodex-acp failed");
console.error("npm error Log files were not written due to an error writing to directory");
process.exit(1);
`,
      "utf8",
    );
    const baseConfig = kyosoConfigSchema.parse(defaultConfig);
    const config: KyosoConfig = {
      ...baseConfig,
      agents: {
        codex: {
          ...baseConfig.agents.codex,
          command: "bun",
          args: [scriptPath],
        },
        claude: {
          ...baseConfig.agents.claude,
          enabled: false,
        },
      },
    };

    const result = await runReview(
      "plan_review",
      {
        goal: "review plan",
        currentPlan: "do it",
        options: { maxAgentTimeoutMs: 5_000 },
      },
      {
        cwd,
        config,
        agentManager: new SubprocessAcpAgentManager(config),
      },
    );

    expect(result.agentOpinions[0]?.errorCode).toBe("AGENT_NETWORK_FAILED");
    expect(result.agentOpinions[0]?.summary).toBe(
      "Agent adapter package could not be resolved due to network or cache failure.",
    );
  });
});

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kyoso-test-"));
}

function rawTextAgentManager(rawText: string) {
  return {
    async runAgent(
      input: Parameters<SubprocessAcpAgentManager["runAgent"]>[0],
    ) {
      return {
        agent: input.agent,
        role: input.role,
        status: "completed" as const,
        rawText,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
    async runAll(
      inputs: Parameters<SubprocessAcpAgentManager["runAgent"]>[0][],
    ) {
      return Promise.all(inputs.map((input) => this.runAgent(input)));
    },
  };
}

function failedAgentManager(errorDetail: string) {
  return {
    async runAgent(
      input: Parameters<SubprocessAcpAgentManager["runAgent"]>[0],
    ) {
      return {
        agent: input.agent,
        role: input.role,
        status: "failed" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: {
          code: "AGENT_FAILED",
          message: "Agent process failed.",
          detail: errorDetail,
        },
      };
    },
    async runAll(
      inputs: Parameters<SubprocessAcpAgentManager["runAgent"]>[0][],
    ) {
      return Promise.all(inputs.map((input) => this.runAgent(input)));
    },
  };
}

function singleAgentConfig(agent: "codex" | "claude"): KyosoConfig {
  const baseConfig = kyosoConfigSchema.parse(defaultConfig);
  return {
    ...baseConfig,
    agents: {
      codex: {
        ...baseConfig.agents.codex,
        enabled: agent === "codex",
      },
      claude: {
        ...baseConfig.agents.claude,
        enabled: agent === "claude",
      },
    },
  };
}

async function readTraceEvents(
  cwd: string,
  config: KyosoConfig,
  result: Awaited<ReturnType<typeof runReview>>,
): Promise<Record<string, unknown>[]> {
  const traceText = await readFile(
    join(
      cwd,
      config.audit.directory,
      result.audit.startedAt.slice(0, 10),
      `${result.audit.traceId}.jsonl`,
    ),
    "utf8",
  );
  return traceText
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
