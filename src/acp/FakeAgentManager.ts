import type {
  AgentRunInput,
  AgentRunResult,
  NormalizedAgentOpinion,
} from "../core/types.js";
import { BaseAcpAgentManager } from "./AcpAgentManager.js";

export type FakeAgentScenario =
  | "success"
  | "markdown_json"
  | "timeout"
  | "malformed"
  | "auth_failure"
  | "permission_request"
  | "write_attempt";

export type FakeVerifierVerdict = {
  findingId: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  reasoning?: string;
  evidence?: string;
};

export type FakeVerifierScenario =
  | "confirmed"
  | "refuted"
  | "uncertain"
  | "malformed"
  | "timeout"
  | { rawText: string }
  | { verdicts: FakeVerifierVerdict[] };

export class FakeAgentManager extends BaseAcpAgentManager {
  readonly calls: AgentRunInput[] = [];

  constructor(
    private readonly scenarios: Partial<
      Record<"codex" | "claude", FakeAgentScenario>
    > = {},
    private readonly verifierScenarios: Partial<
      Record<"codex" | "claude", FakeVerifierScenario>
    > = {},
  ) {
    super();
  }

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    const startedAt = new Date().toISOString();
    if (input.role === "finding_verifier") {
      return verifierResult(
        input,
        startedAt,
        this.verifierScenarios[input.agent] ?? "confirmed",
      );
    }

    const scenario = this.scenarios[input.agent] ?? "success";

    if (scenario === "timeout") {
      return {
        agent: input.agent,
        role: input.role,
        status: "timeout",
        startedAt,
        completedAt: new Date().toISOString(),
        error: { code: "AGENT_TIMEOUT", message: "Fake timeout" },
      };
    }
    if (scenario === "auth_failure") {
      return {
        agent: input.agent,
        role: input.role,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: { code: "AUTH_FAILED", message: "Fake auth failure" },
      };
    }
    if (scenario === "permission_request" || scenario === "write_attempt") {
      return {
        agent: input.agent,
        role: input.role,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code:
            scenario === "permission_request"
              ? "PERMISSION_DENIED"
              : "WRITE_ATTEMPT_DENIED",
          message: "Fake policy denial",
        },
      };
    }

    const opinion = buildOpinion(input.agent, input.role, input.tool);
    const rawText =
      scenario === "markdown_json"
        ? `Notes before JSON\n\n\`\`\`json\n${JSON.stringify(opinion)}\n\`\`\`\n`
        : scenario === "malformed"
          ? "not json"
          : JSON.stringify(opinion);

    return {
      agent: input.agent,
      role: input.role,
      status: "completed",
      rawText,
      normalized: scenario === "success" ? opinion : undefined,
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

function verifierResult(
  input: AgentRunInput,
  startedAt: string,
  scenario: FakeVerifierScenario,
): AgentRunResult {
  if (scenario === "timeout") {
    return {
      agent: input.agent,
      role: input.role,
      status: "timeout",
      startedAt,
      completedAt: new Date().toISOString(),
      error: { code: "AGENT_TIMEOUT", message: "Fake verifier timeout" },
    };
  }

  const rawText =
    scenario === "malformed"
      ? "not json"
      : typeof scenario === "object" && "rawText" in scenario
        ? scenario.rawText
        : JSON.stringify({
            verdicts:
              typeof scenario === "object" && "verdicts" in scenario
                ? scenario.verdicts.map((verdict) => ({
                    findingId: verdict.findingId,
                    verdict: verdict.verdict,
                    reasoning: verdict.reasoning ?? "fake verifier reasoning",
                    evidence: verdict.evidence ?? "fake verifier evidence",
                  }))
                : findingIdsFromPrompt(input.prompt).map((findingId) => ({
                    findingId,
                    verdict: scenario,
                    reasoning: `fake verifier ${scenario}`,
                    evidence: "fake verifier evidence",
                  })),
          });

  return {
    agent: input.agent,
    role: input.role,
    status: "completed",
    rawText,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function findingIdsFromPrompt(prompt: string): string[] {
  return Array.from(prompt.matchAll(/^Finding ID: (.+)$/gm)).map(
    (match) => match[1] ?? "",
  );
}

function buildOpinion(
  agent: "codex" | "claude",
  role: string,
  tool: "plan_review" | "security_review" | "diff_review",
): NormalizedAgentOpinion {
  const securityFinding =
    tool === "security_review" && agent === "claude"
      ? [
          {
            severity: "medium" as const,
            category: "cisa_secure_by_design" as const,
            title: "Add security-specific regression coverage",
            evidence: "Security-sensitive changes need explicit tests.",
            recommendation: "Add authz/security tests before shipping.",
            confidence: "medium" as const,
            cisaMapping: ["governance"],
          },
        ]
      : [];

  return {
    agent,
    role,
    summary: `${agent} reviewed ${tool}`,
    findings: securityFinding,
    testsToAdd: [`${agent}: add regression coverage for ${tool}`],
    residualRisks:
      tool === "security_review"
        ? [`${agent}: verify residual security risk for ${tool}`]
        : [],
    openQuestions: [],
    cisaSecureByDesign:
      tool === "security_review"
        ? {
            governance: agent === "claude" ? "warn" : "pass",
            notes: [`${agent} fake CISA note`],
          }
        : undefined,
  };
}
