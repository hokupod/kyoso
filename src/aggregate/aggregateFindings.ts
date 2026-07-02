import type {
  AgentRunResult,
  CisaDimension,
  FindingCategory,
  KyosoFinding,
  NormalizedAgentOpinion,
} from "../core/types.js";
import { compareSeverity, maxSeverity } from "./severity.js";

const CISA_DIMENSIONS: CisaDimension[] = [
  "customer_security_outcomes",
  "secure_by_default",
  "transparency_and_accountability",
  "governance",
];

const CATEGORIES: FindingCategory[] = [
  "architecture",
  "authn",
  "authz",
  "csrf",
  "xss",
  "ssrf",
  "injection",
  "secret",
  "supply_chain",
  "privacy",
  "data_loss",
  "test",
  "maintainability",
  "cisa_secure_by_design",
  "other",
];

export type AggregatedReview = {
  findings: KyosoFinding[];
  testsToAdd: string[];
  residualRisks: string[];
  disagreements: Array<{
    topic: string;
    positions: Array<{ agent: "codex" | "claude"; opinion: string }>;
    judgeComment: string;
  }>;
};

export function aggregateAgentResults(results: AgentRunResult[]): AggregatedReview {
  const findings = new Map<string, KyosoFinding>();
  const tests = new Set<string>();
  const residualRisks = new Set<string>();
  const opinions: NormalizedAgentOpinion[] = [];

  for (const result of results) {
    if (result.normalized) opinions.push(result.normalized);
    for (const test of result.normalized?.testsToAdd ?? []) tests.add(test);
    for (const risk of result.normalized?.residualRisks ?? []) residualRisks.add(risk);

    for (const finding of result.normalized?.findings ?? []) {
      const category = normalizeCategory(finding.category);
      const key = [
        category,
        finding.title.trim().toLowerCase(),
        finding.recommendation.trim().toLowerCase(),
        (finding.files ?? []).map((file) => file.path).join(","),
      ].join("|");
      const cisaMapping = normalizeCisaMapping(finding.cisaMapping);
      const existing = findings.get(key);
      if (existing) {
        existing.severity = maxSeverity(existing.severity, finding.severity);
        existing.sourceAgents = Array.from(new Set([...existing.sourceAgents, result.agent]));
        existing.confidence = mergeConfidence(existing.confidence, finding.confidence);
        if (cisaMapping.length > 0) {
          existing.cisaMapping = Array.from(new Set([...(existing.cisaMapping ?? []), ...cisaMapping]));
        }
        continue;
      }
      findings.set(key, {
        id: `KYOSO-${findings.size + 1}`,
        severity: finding.severity,
        category,
        title: finding.title,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        files: finding.files,
        sourceAgents: [result.agent],
        confidence: finding.confidence,
        cisaMapping: cisaMapping.length > 0 ? cisaMapping : undefined,
      });
    }
  }

  return {
    findings: Array.from(findings.values()).sort((a, b) => compareSeverity(a.severity, b.severity)),
    testsToAdd: Array.from(tests),
    residualRisks: Array.from(residualRisks),
    disagreements: extractDisagreements(opinions),
  };
}

function extractDisagreements(opinions: NormalizedAgentOpinion[]): AggregatedReview["disagreements"] {
  const codex = opinions.find((opinion) => opinion.agent === "codex");
  const claude = opinions.find((opinion) => opinion.agent === "claude");
  if (!codex || !claude) return [];

  const codexMax = codex.findings.map((finding) => finding.severity).sort(compareSeverity)[0] ?? "info";
  const claudeMax = claude.findings.map((finding) => finding.severity).sort(compareSeverity)[0] ?? "info";
  if (codexMax === claudeMax) return [];

  return [
    {
      topic: "Highest reported severity",
      positions: [
        { agent: "codex", opinion: codexMax },
        { agent: "claude", opinion: claudeMax },
      ],
      judgeComment: "Kyoso preserves the higher-severity signal for deterministic policy decisions.",
    },
  ];
}

function normalizeCategory(category: string): FindingCategory {
  return CATEGORIES.includes(category as FindingCategory) ? (category as FindingCategory) : "other";
}

function normalizeCisaMapping(mapping: string[] | undefined): CisaDimension[] {
  return (mapping ?? []).filter((item): item is CisaDimension =>
    CISA_DIMENSIONS.includes(item as CisaDimension),
  );
}

function mergeConfidence(
  a: "high" | "medium" | "low",
  b: "high" | "medium" | "low",
): "high" | "medium" | "low" {
  const score = { low: 1, medium: 2, high: 3 };
  return score[a] >= score[b] ? a : b;
}
