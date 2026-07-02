import type {
  AgentRunResult,
  AgentName,
  CisaDimension,
  FindingCategory,
  KyosoFinding,
  NormalizedAgentOpinion,
  Severity,
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

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "in",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "without",
]);

const TITLE_SIMILARITY_THRESHOLD = 0.6;

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

export function aggregateAgentResults(
  results: AgentRunResult[],
): AggregatedReview {
  const findings: KyosoFinding[] = [];
  const tests = new Set<string>();
  const residualRisks = new Set<string>();
  const opinions: NormalizedAgentOpinion[] = [];

  for (const result of results) {
    if (result.normalized) opinions.push(result.normalized);
    for (const test of result.normalized?.testsToAdd ?? []) tests.add(test);
    for (const risk of result.normalized?.residualRisks ?? [])
      residualRisks.add(risk);

    for (const finding of result.normalized?.findings ?? []) {
      const category = normalizeCategory(finding.category);
      const candidate: KyosoFinding = {
        id: `KYOSO-${findings.length + 1}`,
        severity: finding.severity,
        category,
        title: finding.title,
        evidence: finding.evidence,
        recommendation: finding.recommendation,
        files: normalizeFiles(finding.files),
        sourceAgents: [result.agent],
        confidence: finding.confidence,
        cisaMapping: normalizeCisaMapping(finding.cisaMapping),
      };
      if (candidate.cisaMapping?.length === 0) delete candidate.cisaMapping;

      const existing = findings.find((item) => sameFinding(item, candidate));
      if (existing) {
        mergeFinding(existing, candidate);
        continue;
      }
      findings.push(candidate);
    }
  }

  return {
    findings: findings.sort((a, b) => compareSeverity(a.severity, b.severity)),
    testsToAdd: Array.from(tests),
    residualRisks: Array.from(residualRisks),
    disagreements: extractDisagreements(opinions),
  };
}

function extractDisagreements(
  opinions: NormalizedAgentOpinion[],
): AggregatedReview["disagreements"] {
  const codex = opinions.find((opinion) => opinion.agent === "codex");
  const claude = opinions.find((opinion) => opinion.agent === "claude");
  if (!codex || !claude) return [];

  const disagreements: AggregatedReview["disagreements"] = [];
  const codexMax =
    codex.findings
      .map((finding) => finding.severity)
      .sort(compareSeverity)[0] ?? "info";
  const claudeMax =
    claude.findings
      .map((finding) => finding.severity)
      .sort(compareSeverity)[0] ?? "info";
  if (codexMax !== claudeMax) {
    disagreements.push({
      topic: "Highest reported severity",
      positions: [
        { agent: "codex", opinion: codexMax },
        { agent: "claude", opinion: claudeMax },
      ],
      judgeComment:
        "Kyoso preserves the higher-severity signal for deterministic policy decisions.",
    });
  }

  const codexFindings = codex.findings.map((finding) =>
    comparableFinding("codex", finding),
  );
  const claudeFindings = claude.findings.map((finding) =>
    comparableFinding("claude", finding),
  );

  for (const codexFinding of codexFindings) {
    for (const claudeFinding of claudeFindings) {
      if (!sameIssueForDisagreement(codexFinding, claudeFinding)) continue;
      if (codexFinding.severity === claudeFinding.severity) continue;
      disagreements.push({
        topic: `Severity disagreement: ${codexFinding.title}`,
        positions: [
          { agent: "codex", opinion: formatFindingOpinion(codexFinding) },
          { agent: "claude", opinion: formatFindingOpinion(claudeFinding) },
        ],
        judgeComment:
          "Kyoso keeps the higher severity when the agents disagree on the same issue.",
      });
    }
  }

  disagreements.push(
    ...riskAssessmentGaps(codexFindings, claudeFindings),
    ...riskAssessmentGaps(claudeFindings, codexFindings),
  );

  return deduplicateDisagreements(disagreements);
}

function normalizeCategory(category: string): FindingCategory {
  return CATEGORIES.includes(category as FindingCategory)
    ? (category as FindingCategory)
    : "other";
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

function normalizeFiles(
  files: KyosoFinding["files"],
): KyosoFinding["files"] | undefined {
  const unique = new Map<string, NonNullable<KyosoFinding["files"]>[number]>();
  for (const file of files ?? []) {
    if (!file.path) continue;
    unique.set(file.path, file);
  }
  const normalized = Array.from(unique.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function sameFinding(a: KyosoFinding, b: KyosoFinding): boolean {
  if (a.category !== b.category) return false;
  if (fileKey(a.files) !== fileKey(b.files)) return false;
  return titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY_THRESHOLD;
}

function mergeFinding(existing: KyosoFinding, candidate: KyosoFinding): void {
  const candidateHasHigherSeverity =
    maxSeverity(existing.severity, candidate.severity) === candidate.severity &&
    existing.severity !== candidate.severity;

  if (candidateHasHigherSeverity) {
    existing.title = candidate.title;
    existing.evidence = candidate.evidence;
    existing.recommendation = candidate.recommendation;
    existing.files = candidate.files;
  }

  existing.severity = maxSeverity(existing.severity, candidate.severity);
  existing.sourceAgents = Array.from(
    new Set([...existing.sourceAgents, ...candidate.sourceAgents]),
  );
  existing.confidence = mergeConfidence(
    existing.confidence,
    candidate.confidence,
  );
  if (candidate.cisaMapping?.length) {
    existing.cisaMapping = Array.from(
      new Set([...(existing.cisaMapping ?? []), ...candidate.cisaMapping]),
    );
  }
}

type ComparableFinding = {
  agent: AgentName;
  severity: Severity;
  category: FindingCategory;
  title: string;
  files?: KyosoFinding["files"];
};

function comparableFinding(
  agent: AgentName,
  finding: NormalizedAgentOpinion["findings"][number],
): ComparableFinding {
  return {
    agent,
    severity: finding.severity,
    category: normalizeCategory(finding.category),
    title: finding.title,
    files: normalizeFiles(finding.files),
  };
}

function sameIssueForDisagreement(
  a: ComparableFinding,
  b: ComparableFinding,
): boolean {
  if (a.category !== b.category) return false;
  const aFiles = fileKey(a.files);
  const bFiles = fileKey(b.files);
  if (aFiles && bFiles && aFiles !== bFiles) return false;
  return titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY_THRESHOLD;
}

function riskAssessmentGaps(
  reporters: ComparableFinding[],
  comparators: ComparableFinding[],
): AggregatedReview["disagreements"] {
  return reporters.flatMap((finding) => {
    if (!isHighSeverity(finding.severity)) return [];
    const sameCategory = comparators.filter(
      (candidate) => candidate.category === finding.category,
    );
    if (sameCategory.some((candidate) => isHighSeverity(candidate.severity))) {
      return [];
    }
    return [
      {
        topic: `Risk assessment gap: ${finding.title}`,
        positions: [
          { agent: finding.agent, opinion: formatFindingOpinion(finding) },
          {
            agent: finding.agent === "codex" ? "claude" : "codex",
            opinion:
              sameCategory.length > 0
                ? sameCategory.map(formatFindingOpinion).join("; ")
                : `no ${finding.category} finding reported`,
          },
        ],
        judgeComment:
          "Kyoso flags high-severity findings that only one agent treated as high risk.",
      },
    ];
  });
}

function deduplicateDisagreements(
  disagreements: AggregatedReview["disagreements"],
): AggregatedReview["disagreements"] {
  const seen = new Set<string>();
  return disagreements.filter((disagreement) => {
    if (seen.has(disagreement.topic)) return false;
    seen.add(disagreement.topic);
    return true;
  });
}

function formatFindingOpinion(finding: ComparableFinding): string {
  return `${finding.severity}: ${finding.title}`;
}

function isHighSeverity(severity: Severity): boolean {
  return severity === "critical" || severity === "high";
}

function fileKey(files: KyosoFinding["files"]): string {
  return (files ?? [])
    .map((file) => file.path)
    .sort()
    .join(",");
}

function titleSimilarity(a: string, b: string): number {
  const aTokens = titleTokens(a);
  const bTokens = titleTokens(b);
  if (aTokens.size === 0 || bTokens.size === 0) {
    return normalizeTitle(a) === normalizeTitle(b) ? 1 : 0;
  }
  const intersection = Array.from(aTokens).filter((token) =>
    bTokens.has(token),
  ).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function titleTokens(value: string): Set<string> {
  return new Set(
    normalizeTitle(value)
      .split(" ")
      .filter((token) => token && !TITLE_STOP_WORDS.has(token)),
  );
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
