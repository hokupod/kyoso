import type {
  AgentName,
  AgentRole,
  CisaSecureByDesignResult,
  FindingCategory,
  GateStatus,
  NormalizedAgentOpinion,
  Severity,
} from "../core/types.js";
import { sanitizeText } from "../security/sanitizeText.js";

const severities: Severity[] = ["critical", "high", "medium", "low", "info"];
const gateStatuses: GateStatus[] = ["pass", "warn", "fail", "not_applicable"];
const categories: FindingCategory[] = [
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

export function normalizeAgentOutput(
  agent: AgentName,
  role: AgentRole,
  rawText: string,
): NormalizedAgentOpinion {
  const json = extractFirstJsonObject(rawText);
  if (!json)
    return parseFailureOpinion(
      agent,
      role,
      "No JSON object found in agent output.",
    );

  try {
    const parsed = JSON.parse(json) as Partial<NormalizedAgentOpinion>;
    return {
      agent,
      role,
      summary:
        typeof parsed.summary === "string"
          ? sanitizeText(parsed.summary)
          : "Agent completed without summary.",
      findings: Array.isArray(parsed.findings)
        ? parsed.findings.map((finding) => ({
            severity: isSeverity(finding.severity) ? finding.severity : "info",
            category: isCategory(finding.category) ? finding.category : "other",
            title: asString(finding.title, "Untitled finding"),
            evidence: asString(finding.evidence, "No evidence provided."),
            recommendation: asString(
              finding.recommendation,
              "Review manually.",
            ),
            files: normalizeFindingFiles(finding.files),
            confidence: isConfidence(finding.confidence)
              ? finding.confidence
              : "low",
            cisaMapping: normalizeStringList(finding.cisaMapping),
          }))
        : [],
      testsToAdd: normalizeStringList(parsed.testsToAdd),
      residualRisks: Array.from(
        new Set([
          ...normalizeStringList(parsed.residualRisks),
          ...normalizeStringList(parsed.openQuestions),
        ]),
      ),
      openQuestions: normalizeStringList(parsed.openQuestions),
      cisaSecureByDesign: normalizeCisaSecureByDesign(
        parsed.cisaSecureByDesign,
      ),
    };
  } catch (error) {
    return parseFailureOpinion(
      agent,
      role,
      `Structured parse failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function parseFailureOpinion(
  agent: AgentName,
  role: AgentRole,
  message: string,
): NormalizedAgentOpinion {
  const sanitizedMessage = sanitizeText(message);
  return {
    agent,
    role,
    summary: sanitizedMessage,
    findings: [
      {
        severity: "info",
        category: "other",
        title: "Agent output could not be parsed",
        evidence: sanitizedMessage,
        recommendation:
          "Inspect the agent output and retry with stricter instructions.",
        confidence: "low",
      },
    ],
    testsToAdd: [],
    residualRisks: [],
    openQuestions: [],
  };
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && severities.includes(value as Severity);
}

function normalizeCisaSecureByDesign(
  value: unknown,
): Partial<CisaSecureByDesignResult> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Partial<CisaSecureByDesignResult> = {};

  const customerSecurityOutcomes = normalizeGateStatus(
    value.customerSecurityOutcomes,
  );
  if (customerSecurityOutcomes)
    normalized.customerSecurityOutcomes = customerSecurityOutcomes;

  const secureByDefault = normalizeGateStatus(value.secureByDefault);
  if (secureByDefault) normalized.secureByDefault = secureByDefault;

  const transparencyAndAccountability = normalizeGateStatus(
    value.transparencyAndAccountability,
  );
  if (transparencyAndAccountability)
    normalized.transparencyAndAccountability = transparencyAndAccountability;

  const governance = normalizeGateStatus(value.governance);
  if (governance) normalized.governance = governance;

  if (Array.isArray(value.notes)) {
    const notes = normalizeStringList(value.notes);
    if (notes.length > 0) normalized.notes = notes;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGateStatus(value: unknown): GateStatus | undefined {
  return typeof value === "string" && gateStatuses.includes(value as GateStatus)
    ? (value as GateStatus)
    : undefined;
}

function isCategory(value: unknown): value is FindingCategory {
  return (
    typeof value === "string" && categories.includes(value as FindingCategory)
  );
}

function isConfidence(value: unknown): value is "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low";
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => sanitizeText(item))
    : [];
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? sanitizeText(value)
    : fallback;
}

function normalizeFindingFiles(
  value: unknown,
): NormalizedAgentOpinion["findings"][number]["files"] | undefined {
  if (!Array.isArray(value)) return undefined;

  const files = value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.path !== "string" ||
      item.path.trim().length === 0
    ) {
      return [];
    }
    const file: NonNullable<
      NormalizedAgentOpinion["findings"][number]["files"]
    >[number] = {
      path: sanitizeText(item.path),
    };
    const lineStart = normalizeLineNumber(item.lineStart);
    const lineEnd = normalizeLineNumber(item.lineEnd);
    if (lineStart !== undefined) file.lineStart = lineStart;
    if (lineEnd !== undefined) file.lineEnd = lineEnd;
    return [file];
  });

  return files.length > 0 ? files : undefined;
}

function normalizeLineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
