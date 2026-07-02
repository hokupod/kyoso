import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubprocessAcpAgentManager } from "../../src/acp/AcpAgentProcess.js";
import { FakeAgentManager, type FakeAgentScenario } from "../../src/acp/FakeAgentManager.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { type KyosoConfig, kyosoConfigSchema } from "../../src/config/schema.js";
import { runReview } from "../../src/core/runReview.js";

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
            content: "export const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';",
          },
        ],
      },
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
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
        selectedFiles: [{ path: `src/${leaked}.ts`, content: "export const value = 1;" }],
      },
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
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
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
    );
    const secretFinding = result.findings.find((finding) => finding.category === "secret");

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
        selectedFiles: [{ path: ".env/production", content: "PASSWORD=local-dev-password" }],
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
        selectedFiles: [{ path: "packages/app/.codex/config.toml", content: "mcp_servers = ['kyoso']" }],
      },
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
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
        selectedFiles: [{ path: "src/secret.ts", content: "const hidden = 1;" }],
      },
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
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
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
    );

    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).toContain("export const visible = 1");
    expect(manager.calls[0]?.prompt).not.toContain("const hidden = 1");
    expect(result.audit.warnings?.join("\n")).toContain("outside workspace allow policy");
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
      { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
    );

    expect(result.decision).toBe("approve");
    expect(manager.calls[0]?.prompt).toContain("export const visible = 1");
    expect(manager.calls[0]?.prompt).not.toContain("const hidden = 1");
    expect(result.audit.warnings?.join("\n")).toContain("outside workspace allow policy");
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
          selectedFiles: [{ path: "src/public.ts", content: "export const visible = 1;" }],
        },
        { cwd, config: kyosoConfigSchema.parse(defaultConfig), agentManager: manager },
      ),
    ).rejects.toThrow("workspace.root is not trusted");
    expect(manager.calls).toHaveLength(0);
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

  test("fake ACP markdown JSON output is normalized by the core pipeline", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "plan_review",
      { goal: "review plan", currentPlan: "do it" },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({ codex: "markdown_json", claude: "markdown_json" }),
      },
    );

    expect(result.decision).toBe("approve");
    expect(result.agentOpinions.map((opinion) => opinion.summary)).toEqual([
      "codex reviewed plan_review",
      "claude reviewed plan_review",
    ]);
    expect(result.testsToAdd).toContain("codex: add regression coverage for plan_review");
    expect(result.testsToAdd).toContain("claude: add regression coverage for plan_review");
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
    expect(result.findings.some((finding) => finding.title === "Agent output could not be parsed")).toBe(true);
    expect(result.agentOpinions.find((opinion) => opinion.agent === "codex")?.summary).toContain("No JSON object found");
  });

  test("one backend timeout returns degraded result", async () => {
    const cwd = await tempCwd();
    const result = await runReview(
      "diff_review",
      {
        goal: "review diff",
        diff: { unifiedDiff: "diff --git a/a.ts b/a.ts\n+export const a = 1;\n" },
      },
      {
        cwd,
        config: kyosoConfigSchema.parse(defaultConfig),
        agentManager: new FakeAgentManager({ claude: "timeout" }),
      },
    );
    expect(result.degraded).toBe(true);
    expect(result.agentOpinions.find((opinion) => opinion.agent === "claude")?.status).toBe("timeout");
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
      expect(result.agentOpinions.find((opinion) => opinion.agent === "codex")?.errorCode).toBe(code);
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
        agentManager: new FakeAgentManager({ codex: "auth_failure", claude: "timeout" }),
      },
    );
    expect(result.decision).toBe("block");
    expect(result.findings.some((finding) => finding.title === "All backend agents failed")).toBe(true);
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
        selectedFiles: [{ path: "src/foo.ts", content: "export const foo = 1;" }],
        options: { maxAgentTimeoutMs: 5_000 },
      },
      {
        cwd: process.cwd(),
        config,
        agentManager: new SubprocessAcpAgentManager(config),
      },
    );
    expect(result.decision).toBe("approve");
    expect(result.agentOpinions[0]?.summary).toContain("read snapshot context and selected file");
    expect(result.testsToAdd).toContain("fake ACP subprocess test");
    expect(result.residualRisks).toContain("fake ACP subprocess residual risk");
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
      { goal: "review plan", currentPlan: "do it", options: { maxAgentTimeoutMs: 5_000 } },
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
});

async function tempCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "kyoso-test-"));
}

function rawTextAgentManager(rawText: string) {
  return {
    async runAgent(input: Parameters<SubprocessAcpAgentManager["runAgent"]>[0]) {
      return {
        agent: input.agent,
        role: input.role,
        status: "completed" as const,
        rawText,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
    async runAll(inputs: Parameters<SubprocessAcpAgentManager["runAgent"]>[0][]) {
      return Promise.all(inputs.map((input) => this.runAgent(input)));
    },
  };
}
