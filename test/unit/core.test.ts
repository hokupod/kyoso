import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { aggregateAgentResults } from "../../src/aggregate/aggregateFindings.js";
import { extractFirstJsonObject, normalizeAgentOutput } from "../../src/acp/normalize.js";
import { loadConfig } from "../../src/config/loadConfig.js";
import { kyosoConfigSchema } from "../../src/config/schema.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { buildContext } from "../../src/context/buildContext.js";
import { isAllowedPath, isDeniedPath, normalizeRelativePath } from "../../src/context/pathPolicy.js";
import { truncateUtf8 } from "../../src/context/truncate.js";
import { sanitizeForAudit } from "../../src/audit/sanitize.js";
import { scanAndRedactSecrets } from "../../src/security/secretScan.js";
import { computeCisaGate } from "../../src/security/cisaGate.js";
import { decide } from "../../src/security/decision.js";
import type { AgentRunResult, KyosoFinding } from "../../src/core/types.js";

describe("config", () => {
  test("default config validates", () => {
    const parsed = kyosoConfigSchema.parse(defaultConfig);
    expect(parsed.agents.codex.command).toBe("npx");
    expect(parsed.workspace.maxContextBytes).toBe(500_000);
  });

  test("loads kyoso.config.ts without silently falling back to defaults", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-config-"));
    await writeFile(
      join(cwd, "kyoso.config.ts"),
      `import { defineConfig } from "@kyoso/cli";
export default defineConfig({
  network: { defaultMode: "unrestricted" },
});
`,
      "utf8",
    );
    const loaded = await loadConfig({ cwd });
    expect(loaded.config.network.defaultMode).toBe("unrestricted");
  });
});

describe("path policy", () => {
  test("normalizes relative paths and rejects traversal", () => {
    expect(normalizeRelativePath("src/../src/index.ts")).toBe("src/index.ts");
    expect(() => normalizeRelativePath("../secret.txt")).toThrow("escapes");
  });

  test("denies credential and dependency paths in nested directories", () => {
    expect(isDeniedPath("packages/app/.env.local", [".env", ".env.*"])).toBe(true);
    expect(isDeniedPath("packages/app/.ssh/id_rsa", [".ssh"])).toBe(true);
    expect(isDeniedPath("packages/app/node_modules/pkg/index.js", ["node_modules"])).toBe(true);
    expect(isDeniedPath("src/environment.ts", [".env", ".env.*"])).toBe(false);
  });

  test("allows only explicit allowRead paths when configured", () => {
    expect(isAllowedPath("src/public.ts", ["src/public.ts"])).toBe(true);
    expect(isAllowedPath("src/public/nested.ts", ["src/public"])).toBe(true);
    expect(isAllowedPath("src/public.ts", ["src"])).toBe(true);
    expect(isAllowedPath("src/public.ts", ["src/*.ts"])).toBe(true);
    expect(isAllowedPath(".env.local", [".env.*"])).toBe(true);
    expect(isAllowedPath("src/secret.ts", ["src/public.ts"])).toBe(false);
    expect(isAllowedPath("packages/app/src/public.ts", ["src/public.ts"])).toBe(false);
    expect(isAllowedPath("packages/app/src/public.ts", ["src"])).toBe(false);
    expect(isAllowedPath("packages/app/src/public.ts", ["src/*.ts"])).toBe(false);
    expect(isAllowedPath("packages/app/.env.local", [".env.*"])).toBe(false);
  });
});

describe("secret scan", () => {
  test("redacts known token patterns", () => {
    const scan = scanAndRedactSecrets({
      goal: "review",
      currentPlan: "token = sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(scan.detected).toBe(true);
    expect(scan.redactedRequest.currentPlan).toContain("[KYOSO_REDACTED]");
  });

  test("redacts secrets in constraints before prompt construction", () => {
    const scan = scanAndRedactSecrets({
      goal: "review",
      constraints: ["api_key = sk-proj-abcdefghijklmnopqrstuvwxyz123456"],
    });
    expect(scan.detected).toBe(true);
    expect(scan.redactedRequest.constraints?.[0]).toContain("[KYOSO_REDACTED]");
  });

  test("redacts credential file contents when the path is sensitive", () => {
    const scan = scanAndRedactSecrets({
      goal: "review",
      selectedFiles: [
        { path: "packages/app/.env.local", content: "PASSWORD=local-dev-password" },
        { path: "packages/app/.env/production", content: "PASSWORD=production-password" },
      ],
    });

    expect(scan.detected).toBe(true);
    expect(scan.redactedRequest.selectedFiles?.[0]?.content).toBe("[KYOSO_REDACTED]");
    expect(scan.redactedRequest.selectedFiles?.[1]?.content).toBe("[KYOSO_REDACTED]");
  });

  test("redacts secrets from selected file paths and match locations", () => {
    const leaked = `sk-${"proj"}-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const scan = scanAndRedactSecrets({
      goal: "review",
      selectedFiles: [{ path: `src/${leaked}.ts`, content: "export const value = 1;" }],
    });

    expect(scan.detected).toBe(true);
    expect(scan.redactedRequest.selectedFiles?.[0]?.path).toBe("src/[KYOSO_REDACTED].ts");
    expect(JSON.stringify(scan.matches)).not.toContain(leaked);
    expect(scan.matches).toContainEqual({
      kind: "openai_api_key",
      location: "selectedFiles[0].path",
    });
  });
});

describe("truncate", () => {
  test("truncates by utf8 budget", () => {
    const result = truncateUtf8("a".repeat(100), 40);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("[KYOSO_TRUNCATED");
    expect(result.bytes).toBeLessThanOrEqual(40);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(40);
  });

  test("keeps tiny truncation budgets hard-capped", () => {
    const result = truncateUtf8("abcdef", 3);
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(3);
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(3);
  });
});

describe("context budget", () => {
  test("applies maxContextBytes across text context before selected files", () => {
    const built = buildContext(
      {
        goal: "g".repeat(40),
        repoSummary: "r".repeat(40),
        currentPlan: "p".repeat(40),
        constraints: ["c".repeat(40)],
        selectedFiles: [{ path: "src/a.ts", content: "f".repeat(40) }],
      },
      { maxContextBytes: 70, maxDiffBytes: 1_000, denyPatterns: [] },
    );
    const contextBytes = new TextEncoder().encode(
      [
        built.request.goal,
        built.request.repoSummary ?? "",
        built.request.currentPlan ?? "",
        ...(built.request.constraints ?? []),
        ...(built.request.selectedFiles ?? []).map((file) => file.content),
      ].join(""),
    ).byteLength;

    expect(contextBytes).toBeLessThanOrEqual(70);
    expect(built.request.repoSummary).toHaveLength(30);
    expect(built.request.currentPlan).toBe("");
    expect(built.request.constraints).toEqual([]);
    expect(built.request.selectedFiles?.[0]?.content).toBe("");
    expect(built.warnings).toContain("Repo summary truncated");
    expect(built.warnings).toContain("Current plan truncated");
    expect(built.warnings).toContain("Constraint truncated: constraints[0]");
    expect(built.warnings).toContain("Selected file truncated: src/a.ts");
  });
});

describe("agent JSON extraction", () => {
  test("extracts first object from Markdown wrapped output", () => {
    const json = extractFirstJsonObject("before\n```json\n{\"summary\":\"ok\"}\n```");
    expect(json).toBe("{\"summary\":\"ok\"}");
  });

  test("normalizes malformed output as parse finding", () => {
    const opinion = normalizeAgentOutput("codex", "implementation_reviewer", "not-json");
    expect(opinion.findings[0]?.title).toBe("Agent output could not be parsed");
  });

  test("normalizes CISA gate values from agent output", () => {
    const opinion = normalizeAgentOutput(
      "claude",
      "architecture_security_reviewer",
      JSON.stringify({
        summary: "ok",
        findings: [],
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
        cisaSecureByDesign: {
          customerSecurityOutcomes: "block",
          secureByDefault: "warn",
          transparencyAndAccountability: "not_applicable",
          governance: "fail",
          notes: ["valid note", 123],
        },
      }),
    );

    expect(opinion.cisaSecureByDesign).toEqual({
      secureByDefault: "warn",
      transparencyAndAccountability: "not_applicable",
      governance: "fail",
      notes: ["valid note"],
    });
  });

  test("sanitizes successful agent JSON before aggregation", () => {
    const leakedToken = `sk-${"proj"}-${"abcdefghijklmnopqrstuvwxyz123456"}`;
    const leakedCredential = `api_${"key"}=${"supersecret123456"}`;
    const opinion = normalizeAgentOutput(
      "codex",
      "implementation_reviewer",
      JSON.stringify({
        summary: `summary ${leakedToken}`,
        findings: [
          {
            severity: "medium",
            category: "secret",
            title: `title ${leakedCredential}`,
            evidence: `evidence ${leakedToken}`,
            recommendation: `rotate ${leakedCredential}`,
            files: [
              { path: `src/${leakedToken}.ts`, lineStart: 12, lineEnd: "13" },
              { path: "", lineStart: 1 },
            ],
            confidence: "high",
            cisaMapping: [leakedToken, "customer_security_outcomes"],
          },
        ],
        testsToAdd: [`test ${leakedToken}`],
        residualRisks: [`risk ${leakedCredential}`],
        openQuestions: [`question ${leakedToken}`],
        cisaSecureByDesign: {
          customerSecurityOutcomes: "warn",
          notes: [`note ${leakedCredential}`],
        },
      }),
    );

    const serialized = JSON.stringify(opinion);
    expect(serialized).not.toContain(leakedToken);
    expect(serialized).not.toContain(leakedCredential);
    expect(serialized).toContain("[KYOSO_REDACTED]");
    expect(opinion.findings[0]?.files).toEqual([
      { path: "src/[KYOSO_REDACTED].ts", lineStart: 12 },
    ]);
    expect(opinion.cisaSecureByDesign?.notes).toEqual(["note [KYOSO_REDACTED]"]);
  });
});

describe("aggregation", () => {
  test("deduplicates findings and preserves source agents", () => {
    const results: AgentRunResult[] = [
      completed("codex", "medium"),
      completed("claude", "high"),
    ];
    const aggregated = aggregateAgentResults(results);
    expect(aggregated.findings).toHaveLength(1);
    expect(aggregated.findings[0]?.severity).toBe("high");
    expect(aggregated.findings[0]?.sourceAgents).toEqual(["codex", "claude"]);
  });
});

describe("CISA gate and decision", () => {
  test("security findings influence gate and decision", () => {
    const findings: KyosoFinding[] = [
      {
        id: "KYOSO-1",
        severity: "high",
        category: "authz",
        title: "Authz bypass",
        evidence: "tenant id trusted from client",
        recommendation: "Derive tenant from session.",
        sourceAgents: ["claude"],
        confidence: "high",
        cisaMapping: ["customer_security_outcomes"],
      },
    ];
    const cisa = computeCisaGate(findings, []);
    expect(cisa.customerSecurityOutcomes).toBe("fail");
    expect(
      decide({
        tool: "security_review",
        findings,
        cisa,
        degraded: false,
        secretScan: { detected: false, blocked: false },
      }),
    ).toBe("block");
  });
});

describe("audit sanitize", () => {
  test("removes raw/content/env fields and token-like values", () => {
    const sanitized = sanitizeForAudit({
      token: "sk-proj-abcdefghijklmnop",
      path: "src/index.ts",
      rawText: "secret",
      nested: { content: "file body" },
    }) as Record<string, unknown>;
    expect(sanitized.path).toBe("src/index.ts");
    expect(sanitized.token).toBeUndefined();
    expect(sanitized.rawText).toBeUndefined();
    expect(sanitized.nested).toEqual({});
  });
});

function completed(agent: "codex" | "claude", severity: "medium" | "high"): AgentRunResult {
  return {
    agent,
    role: agent === "codex" ? "implementation_reviewer" : "architecture_security_reviewer",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    normalized: {
      agent,
      role: agent === "codex" ? "implementation_reviewer" : "architecture_security_reviewer",
      summary: "ok",
      findings: [
        {
          severity,
          category: "maintainability",
          title: "Same issue",
          evidence: "same evidence",
          recommendation: "same fix",
          confidence: "medium",
        },
      ],
      testsToAdd: ["add test"],
      residualRisks: [],
      openQuestions: [],
    },
  };
}
