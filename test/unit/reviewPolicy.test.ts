import { describe, expect, test } from "bun:test";
import { normalizeAgentOutput } from "../../src/acp/normalize.js";
import { aggregateAgentResults } from "../../src/aggregate/aggregateFindings.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { collectProjectScopeViolations } from "../../src/config/projectScope.js";
import { kyosoConfigSchema } from "../../src/config/schema.js";
import {
  admitFindings,
  buildAdmissionOpenQuestions,
  selectRegressionTests,
} from "../../src/core/findingAdmission.js";
import {
  buildReviewCoverage,
  isCoverageIncomplete,
  resolveRequiredLenses,
} from "../../src/core/reviewPolicy.js";
import { validateReviewRequest } from "../../src/core/validateRequest.js";
import {
  defaultSummaryText,
  renderMarkdownResult,
} from "../../src/output/markdown.js";
import type {
  AgentRunResult,
  KyosoFinding,
  KyosoResult,
  KyosoReviewRequest,
  Severity,
} from "../../src/core/types.js";
import { kyosoReviewRequestSchema } from "../../src/mcp/schemas.js";
import { computeCisaGate } from "../../src/security/cisaGate.js";
import { decide } from "../../src/security/decision.js";

const DIFF_REQUEST: KyosoReviewRequest = {
  goal: "Review the authorization change.",
  diff: {
    unifiedDiff: [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -9,1 +9,2 @@",
      " export function loadTenant() {",
      "+  return request.tenantId;",
    ].join("\n"),
  },
};

describe("finding admission", () => {
  test("classifies the deterministic disposition matrix", () => {
    const cases: Array<{
      severity: Severity;
      expected: KyosoFinding["disposition"];
    }> = [
      { severity: "high", expected: "gate" },
      { severity: "medium", expected: "actionable" },
      { severity: "low", expected: "advisory" },
      { severity: "info", expected: "advisory" },
    ];

    for (const item of cases) {
      const [admitted] = admitFindings({
        tool: "diff_review",
        request: DIFF_REQUEST,
        findings: [changedFinding(item.severity)],
        reviewMode: "single_agent",
      });
      expect(admitted?.disposition).toBe(item.expected);
      expect(admitted?.changeRelation).toBe("introduced");
      expect(admitted?.evidenceQuality).toBe("concrete");
      expect(admitted?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("keeps pre-existing Medium findings advisory", () => {
    const finding = changedFinding("medium", {
      changeRelation: "pre_existing",
      evidenceRefs: [{ kind: "file", path: "src/existing.ts", lineStart: 1 }],
      files: [{ path: "src/existing.ts", lineStart: 1 }],
    });
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: {
        ...DIFF_REQUEST,
        selectedFiles: [
          { path: "src/existing.ts", content: "export const existing = true;" },
        ],
      },
      findings: [finding],
      reviewMode: "single_agent",
    });

    expect(admitted?.changeRelation).toBe("pre_existing");
    expect(admitted?.disposition).toBe("advisory");
    expect(admitted?.policyReasons).toContain("pre_existing_medium");
  });

  test("does not use a plan clause to prove a diff finding was introduced", () => {
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: { ...DIFF_REQUEST, currentPlan: "Change tenant behavior" },
      findings: [
        changedFinding("medium", {
          evidenceRefs: [
            { kind: "plan_clause", label: "Change tenant behavior" },
          ],
        }),
      ],
      reviewMode: "single_agent",
    });

    expect(admitted?.evidenceQuality).toBe("concrete");
    expect(admitted?.changeRelation).toBe("unknown");
    expect(admitted?.disposition).toBe("advisory");
  });

  test("does not record a removed line as a changed new-file line", () => {
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: {
        goal: "Review removed authorization",
        diff: {
          unifiedDiff: [
            "diff --git a/src/auth.ts b/src/auth.ts",
            "--- a/src/auth.ts",
            "+++ b/src/auth.ts",
            "@@ -9,2 +9,1 @@",
            "-  assertTenantAccess();",
            "   return loadTenant();",
          ].join("\n"),
        },
      },
      findings: [
        changedFinding("high", {
          evidenceRefs: [
            { kind: "diff_hunk", path: "src/auth.ts", lineStart: 9 },
          ],
          files: [{ path: "src/auth.ts", lineStart: 9 }],
        }),
      ],
      reviewMode: "single_agent",
    });

    expect(admitted?.changeRelation).toBe("unknown");
    expect(admitted?.evidenceQuality).toBe("partial");
    expect(admitted?.disposition).toBe("disputed");
  });

  test("applies accepted Medium risk by stable fingerprint", () => {
    const finding = changedFinding("medium");
    const [baseline] = admitFindings({
      tool: "diff_review",
      request: DIFF_REQUEST,
      findings: [finding],
      reviewMode: "single_agent",
    });
    const fingerprint = baseline!.fingerprint;
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: {
        ...DIFF_REQUEST,
        reviewContract: {
          acceptedRisks: [
            { findingFingerprint: fingerprint, rationale: "temporary rollout" },
          ],
        },
      },
      findings: [finding],
      reviewMode: "single_agent",
    });

    expect(admitted?.disposition).toBe("advisory");
    expect(admitted?.policyReasons).toContain(
      "accepted_risk: temporary rollout",
    );
  });

  test("does not trust agent policy reasons for non-goal demotion", () => {
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: {
        ...DIFF_REQUEST,
        reviewContract: { nonGoals: ["legacy tenant migration"] },
      },
      findings: [
        changedFinding("medium", {
          policyReasons: ["legacy tenant migration"],
        }),
      ],
      reviewMode: "single_agent",
    });

    expect(admitted?.disposition).toBe("actionable");
    expect(admitted?.policyReasons).toEqual(["concrete_changed_medium"]);

    const opinion = normalizeAgentOutput(
      "codex",
      "combined_reviewer",
      JSON.stringify({
        summary: "reviewed",
        findings: [
          {
            severity: "medium",
            category: "authz",
            title: "Injected non-goal label",
            evidence:
              "The changed tenant lookup crosses an authorization boundary.",
            recommendation: "Derive the tenant from the authenticated session.",
            evidenceRefs: [
              { kind: "diff_hunk", path: "src/auth.ts", lineStart: 10 },
            ],
            policyReasons: ["legacy tenant migration"],
            confidence: "high",
          },
        ],
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
      }),
    );
    expect(opinion.findings[0]).not.toHaveProperty("policyReasons");
  });

  test("sends refuted or insufficient findings away from auto-fix", () => {
    const [refuted] = admitFindings({
      tool: "diff_review",
      request: DIFF_REQUEST,
      findings: [
        changedFinding("high", {
          confidence: "low",
          verification: { status: "refuted", verifier: "claude" },
        }),
      ],
      reviewMode: "single_agent",
    });
    const [insufficient] = admitFindings({
      tool: "plan_review",
      request: { goal: "Review plan", currentPlan: "Add tenant support." },
      findings: [
        changedFinding("medium", {
          evidenceRefs: [],
          files: undefined,
          changeRelation: "unknown",
        }),
      ],
      reviewMode: "single_agent",
    });

    expect(refuted?.disposition).toBe("disputed");
    expect(refuted?.policyReasons).toContain("verification_refuted");
    expect(insufficient?.disposition).toBe("advisory");
    expect(insufficient?.evidenceQuality).toBe("insufficient");
    expect(buildAdmissionOpenQuestions([insufficient!])).toHaveLength(1);
  });

  test("ignores model disposition and keeps parse/style noise advisory", () => {
    const opinion = normalizeAgentOutput(
      "codex",
      "combined_reviewer",
      JSON.stringify({
        summary: "reviewed",
        findings: [
          {
            severity: "medium",
            category: "maintainability",
            title: "Formatting style-only change",
            evidence: "The changed line uses a different whitespace style.",
            recommendation: "Apply optional formatting for consistency.",
            disposition: "gate",
            changeRelation: "introduced",
            evidenceRefs: [
              { kind: "diff_hunk", path: "src/auth.ts", lineStart: 10 },
            ],
            confidence: "high",
          },
        ],
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
      }),
    );
    const aggregate = aggregateAgentResults([
      completedResult("codex", "combined_reviewer", opinion),
    ]);
    const [style] = admitFindings({
      tool: "diff_review",
      request: DIFF_REQUEST,
      findings: aggregate.findings,
      reviewMode: "single_agent",
    });
    const malformed = normalizeAgentOutput(
      "codex",
      "combined_reviewer",
      "not json",
    );
    const malformedAggregate = aggregateAgentResults([
      completedResult("codex", "combined_reviewer", malformed),
    ]);
    const [parseFailure] = admitFindings({
      tool: "plan_review",
      request: { goal: "Review plan" },
      findings: malformedAggregate.findings,
      reviewMode: "single_agent",
    });

    expect(style?.disposition).toBe("advisory");
    expect(style?.policyReasons).toContain("optional_or_style");
    expect(parseFailure?.disposition).toBe("advisory");
  });

  test("bounds untrusted evidence references and line ranges", () => {
    const opinion = normalizeAgentOutput(
      "codex",
      "combined_reviewer",
      JSON.stringify({
        summary: "reviewed",
        findings: [
          {
            severity: "medium",
            category: "authz",
            title: "Bound evidence references",
            evidence:
              "A changed tenant lookup can cross an authorization boundary.",
            recommendation: "Derive the tenant from the authenticated session.",
            evidenceRefs: Array.from({ length: 25 }, (_, index) => ({
              kind: "diff_hunk",
              path: "src/auth.ts",
              lineStart: index + 1,
              lineEnd: Number.MAX_SAFE_INTEGER,
            })),
            confidence: "high",
          },
        ],
        testsToAdd: [],
        residualRisks: [],
        openQuestions: [],
      }),
    );

    expect(opinion.findings[0]?.evidenceRefs).toHaveLength(20);
    expect(opinion.findings[0]?.evidenceRefs?.[0]?.lineEnd).toBeUndefined();
  });

  test("rejects an out-of-range selected-file reference as concrete evidence", () => {
    const [admitted] = admitFindings({
      tool: "diff_review",
      request: {
        ...DIFF_REQUEST,
        selectedFiles: [
          { path: "src/auth.ts", content: "export const tenant = true;" },
        ],
      },
      findings: [
        changedFinding("medium", {
          evidenceRefs: [{ kind: "file", path: "src/auth.ts", lineStart: 999 }],
        }),
      ],
      reviewMode: "single_agent",
    });

    expect(admitted?.evidenceQuality).toBe("partial");
    expect(admitted?.changeRelation).toBe("unknown");
    expect(admitted?.disposition).toBe("advisory");
  });

  test("keeps at most three specific regression tests", () => {
    expect(
      selectRegressionTests([
        "Add more tests",
        "Please add more tests",
        "We should improve test coverage",
        "Run the full test suite",
        "invalid tenant id returns 403",
        " INVALID TENANT ID RETURNS 403 ",
        "missing session tenant returns 401",
        "cross-tenant id cannot load data",
        "valid tenant still loads data",
      ]),
    ).toEqual([
      "invalid tenant id returns 403",
      "missing session tenant returns 401",
      "cross-tenant id cannot load data",
    ]);
  });
});

describe("review coverage", () => {
  test("reports independent completion and missing perspectives", () => {
    const request: KyosoReviewRequest = { goal: "Review plan" };
    const complete = buildReviewCoverage({
      request,
      agentResults: [
        completedResult("codex", "implementation_reviewer"),
        completedResult("claude", "architecture_security_reviewer"),
      ],
    });
    const missing = buildReviewCoverage({
      request,
      agentResults: [
        completedResult("codex", "implementation_reviewer"),
        failedResult("claude", "architecture_security_reviewer"),
      ],
    });

    expect(complete.independentReview).toBe(true);
    expect(isCoverageIncomplete(complete, { multiAgentRequired: true })).toBe(
      false,
    );
    expect(missing.completedPerspectives).toEqual(["implementation_reviewer"]);
    expect(isCoverageIncomplete(missing, { multiAgentRequired: false })).toBe(
      true,
    );
  });

  test("combined single-agent attempts both perspectives without independence", () => {
    const coverage = buildReviewCoverage({
      request: { goal: "Review plan" },
      agentResults: [completedResult("codex", "combined_reviewer")],
    });

    expect(coverage.completedPerspectives).toEqual([
      "implementation_reviewer",
      "architecture_security_reviewer",
    ]);
    expect(coverage.independentReview).toBe(false);
    expect(isCoverageIncomplete(coverage, { multiAgentRequired: false })).toBe(
      false,
    );
    expect(isCoverageIncomplete(coverage, { multiAgentRequired: true })).toBe(
      true,
    );
  });

  test("keeps the built-in floor and adds conditional or focused lenses", () => {
    const lenses = resolveRequiredLenses({
      goal: "Update release workflow for a large parallel upload",
      reviewContract: { focus: ["documentation"] },
    });

    expect(lenses).toEqual(
      expect.arrayContaining([
        "correctness",
        "regression",
        "security_boundaries",
        "secrets_and_injection",
        "data_integrity",
        "public_contract",
        "supply_chain",
        "resource_amplification",
        "documentation",
      ]),
    );
  });
});

describe("CISA and policy sources", () => {
  test("keeps raw CISA failure advisory when no admitted finding exists", () => {
    const result = completedResult("claude", "architecture_security_reviewer", {
      agent: "claude",
      role: "architecture_security_reviewer",
      summary: "raw status",
      findings: [],
      testsToAdd: [],
      residualRisks: [],
      openQuestions: [],
      cisaSecureByDesign: {
        customerSecurityOutcomes: "fail",
        notes: ["raw failure"],
      },
    });
    const cisa = computeCisaGate([], [result]);

    expect(cisa.customerSecurityOutcomes).toBe("pass");
    expect(cisa.notes).toContain("Agent-reported advisory: raw failure");
  });

  test("derives CISA from active findings and respects gate/dimensions", () => {
    const [finding] = admitFindings({
      tool: "diff_review",
      request: DIFF_REQUEST,
      findings: [changedFinding("high")],
      reviewMode: "single_agent",
    });
    const cisa = computeCisaGate([finding!], []);
    const dimensionsDisabled = computeCisaGate([finding!], [], {
      enabled: true,
      gate: true,
      dimensions: {
        customerSecurityOutcomes: false,
        secureByDefault: true,
        transparencyAndAccountability: true,
        governance: true,
      },
    });

    expect(cisa.customerSecurityOutcomes).toBe("fail");
    expect(
      decide({
        tool: "security_review",
        findings: [finding!],
        cisa,
        degraded: false,
        secretScan: { detected: false, blocked: false },
      }),
    ).toBe("block");
    expect(
      decide({
        tool: "security_review",
        findings: [finding!],
        cisa: undefined,
        degraded: false,
        secretScan: { detected: false, blocked: false },
      }),
    ).toBe("approve_with_changes");
    expect(dimensionsDisabled.customerSecurityOutcomes).toBe("not_applicable");
    expect(
      decide({
        tool: "security_review",
        findings: [],
        cisa: {
          ...cisa,
          gateEnabled: false,
          customerSecurityOutcomes: "fail",
        },
        degraded: false,
        secretScan: { detected: false, blocked: false },
      }),
    ).toBe("approve");
  });

  test("caps actionable CISA findings at warn", () => {
    const actionableHigh = changedFinding("high", {
      disposition: "actionable",
    });
    const cisa = computeCisaGate([actionableHigh], []);

    expect(cisa.customerSecurityOutcomes).toBe("warn");
    expect(cisa.secureByDefault).toBe("warn");
  });

  test("rejects project tool/review-policy settings and validates MCP contract", () => {
    expect(
      collectProjectScopeViolations({
        tools: { planReview: false },
        reviewPolicy: { multiAgentRequired: false },
      }).map((violation) => violation.path),
    ).toEqual(["reviewPolicy.multiAgentRequired", "tools.planReview"]);

    const parsed = kyosoReviewRequestSchema.parse({
      goal: "Review plan",
      reviewContract: {
        focus: ["performance"],
        nonGoals: ["UI redesign"],
        acceptedRisks: [
          {
            findingFingerprint: `sha256:${"1".repeat(64)}`,
            rationale: "temporary migration",
          },
        ],
      },
    });
    expect(parsed.reviewContract?.focus).toEqual(["performance"]);
    expect(() =>
      kyosoReviewRequestSchema.parse({
        goal: "Review plan",
        reviewContract: { focus: ["security"] },
      }),
    ).toThrow();
    expect(() =>
      validateReviewRequest("plan_review", {
        goal: "Review plan",
        reviewContract: { acceptedRisks: [null] },
      } as never),
    ).toThrow("reviewContract.acceptedRisks");
    expect(() =>
      validateReviewRequest("plan_review", {
        goal: "Review plan",
        reviewContract: { focuss: ["performance"] },
      } as never),
    ).toThrow("reviewContract contains unknown keys: focuss");
    expect(() =>
      validateReviewRequest("plan_review", {
        goal: "Review plan",
        selectedFiles: [{ path: "src/a.ts" }],
      } as never),
    ).toThrow("selectedFiles entries require string path/content");
  });

  test("rejects unsupported values for fixed or reserved config fields", () => {
    const invalid = [
      { ...defaultConfig, firstClassClient: "claude" },
      {
        ...defaultConfig,
        workspace: { ...defaultConfig.workspace, readOnly: false },
      },
      {
        ...defaultConfig,
        network: { ...defaultConfig.network, mediatedWeb: { enabled: true } },
      },
      {
        ...defaultConfig,
        audit: { ...defaultConfig.audit, includeFileContents: true },
      },
    ];

    for (const config of invalid) {
      expect(kyosoConfigSchema.safeParse(config).success).toBe(false);
    }
    expect(
      kyosoConfigSchema.safeParse({
        ...defaultConfig,
        verification: { ...defaultConfig.verification, allowDemotion: true },
      }).success,
    ).toBe(true);
  });
});

describe("finding Markdown output", () => {
  test("separates disputed counts and renders evidence line ranges", () => {
    const finding = changedFinding("high", {
      disposition: "disputed",
      evidenceRefs: [
        {
          kind: "diff_hunk",
          path: "src/auth.ts",
          lineStart: 10,
          lineEnd: 12,
        },
      ],
    });
    const result = markdownResult([finding]);

    expect(defaultSummaryText(result)).toBe(
      "0 decision-active finding(s); 0 advisory finding(s); 1 disputed finding(s).",
    );
    expect(renderMarkdownResult("diff_review", result)).toContain(
      "diff_hunk=`src/auth.ts:10-12`",
    );
  });
});

function changedFinding(
  severity: Severity,
  overrides: Partial<KyosoFinding> = {},
): KyosoFinding {
  return {
    id: "KYOSO-1",
    severity,
    category: "authz",
    title: "Tenant boundary bypass",
    evidence:
      "The changed return statement trusts a request tenant id and permits cross-tenant reads.",
    recommendation:
      "Derive the tenant id from the authenticated session before loading data.",
    disposition: "advisory",
    changeRelation: "introduced",
    evidenceQuality: "insufficient",
    evidenceRefs: [{ kind: "diff_hunk", path: "src/auth.ts", lineStart: 10 }],
    policyReasons: [],
    fingerprint: "",
    files: [{ path: "src/auth.ts", lineStart: 10 }],
    sourceAgents: ["codex", "claude"],
    crossValidation: "corroborated",
    confidence: "high",
    ...overrides,
  };
}

function completedResult(
  agent: "codex" | "claude",
  role: AgentRunResult["role"],
  normalized?: AgentRunResult["normalized"],
): AgentRunResult {
  return {
    agent,
    role,
    status: "completed",
    normalized,
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
  };
}

function failedResult(
  agent: "codex" | "claude",
  role: AgentRunResult["role"],
): AgentRunResult {
  return {
    agent,
    role,
    status: "failed",
    error: { code: "AGENT_FAILED", message: "failed" },
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:01.000Z",
  };
}

function markdownResult(
  findings: KyosoFinding[],
): Omit<KyosoResult, "summaryMarkdown"> {
  return {
    decision: "approve",
    completion: { status: "complete", reasons: [], retryable: false },
    executionBudget: {
      maxModelCalls: 0,
      modelCalls: {
        planned: 0,
        consumed: 0,
        skipped: 0,
        byKind: {
          primary: { planned: 0, consumed: 0, skipped: 0 },
          verifier: { planned: 0, consumed: 0, skipped: 0 },
          judge: { planned: 0, consumed: 0, skipped: 0 },
        },
      },
      wallTime: { limitMs: 0, consumedMs: 0, remainingMs: 0 },
      maxAgentOutputBytes: 0,
      maxFindingsPerAgent: 0,
      skipOptionalPhasesWhenTokenUsageUnknown: true,
      agentOutputBytes: {},
      tokenUsage: {
        status: "reported",
        reportedCalls: 0,
        unknownCalls: 0,
        totals: {},
      },
    },
    requestFingerprint: `sha256:${"0".repeat(64)}`,
    degraded: false,
    agentsUsed: [],
    reviewMode: "multi_agent",
    coverage: {
      requiredLenses: [],
      attemptedLenses: [],
      missingLenses: [],
      requiredPerspectives: [],
      completedPerspectives: [],
      independentReview: false,
    },
    findings,
    disagreements: [],
    testsToAdd: [],
    residualRisks: [],
    openQuestions: [],
    agentOpinions: [],
    audit: {
      traceId: "trace",
      startedAt: "2026-07-16T00:00:00.000Z",
      completedAt: "2026-07-16T00:00:00.000Z",
      agentsUsed: [],
      redactionsApplied: 0,
      networkMode: "model_only",
      workspaceMode: "temp_snapshot",
      modelCalls: [],
    },
  };
}
