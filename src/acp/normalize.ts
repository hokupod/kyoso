import type {
  AgentName,
  AgentRole,
  ChangeRelation,
  CisaSecureByDesignResult,
  EvidenceQuality,
  EvidenceRef,
  FindingDisposition,
  FindingCategory,
  GateStatus,
  NormalizedAgentOpinion,
  Severity,
} from "../core/types.js";
import { selectRegressionTests } from "../core/findingAdmission.js";
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
const dispositions: FindingDisposition[] = [
  "gate",
  "actionable",
  "advisory",
  "disputed",
];
const changeRelations: ChangeRelation[] = [
  "introduced",
  "worsened",
  "pre_existing",
  "unknown",
];
const evidenceQualities: EvidenceQuality[] = [
  "concrete",
  "partial",
  "insufficient",
];
const MAX_EVIDENCE_REFS = 20;
const MAX_EVIDENCE_LINE = 1_000_000;
const STRICT_ROOT_KEYS = new Set([
  "summary",
  "findings",
  "testsToAdd",
  "residualRisks",
  "openQuestions",
  "cisaSecureByDesign",
]);
const STRICT_FINDING_KEYS = new Set([
  "severity",
  "category",
  "title",
  "evidence",
  "recommendation",
  "disposition",
  "changeRelation",
  "evidenceQuality",
  "evidenceRefs",
  "files",
  "confidence",
  "cisaMapping",
]);
const STRICT_FILE_KEYS = new Set(["path", "lineStart", "lineEnd"]);
const STRICT_EVIDENCE_REF_KEYS = new Set([
  "kind",
  "path",
  "lineStart",
  "lineEnd",
  "label",
]);
const STRICT_CISA_KEYS = new Set([
  "customerSecurityOutcomes",
  "secureByDefault",
  "transparencyAndAccountability",
  "governance",
  "notes",
]);

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
            disposition: isDisposition(finding.disposition)
              ? finding.disposition
              : undefined,
            changeRelation: isChangeRelation(finding.changeRelation)
              ? finding.changeRelation
              : undefined,
            evidenceQuality: isEvidenceQuality(finding.evidenceQuality)
              ? finding.evidenceQuality
              : undefined,
            evidenceRefs: normalizeEvidenceRefs(finding.evidenceRefs),
            files: normalizeFindingFiles(finding.files),
            confidence: isConfidence(finding.confidence)
              ? finding.confidence
              : "low",
            cisaMapping: normalizeStringList(finding.cisaMapping),
          }))
        : [],
      testsToAdd: selectRegressionTests(normalizeStringList(parsed.testsToAdd)),
      residualRisks: normalizeStringList(parsed.residualRisks),
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

export function parseAgentOutputStrict(
  agent: AgentName,
  role: AgentRole,
  rawText: string,
): NormalizedAgentOpinion | undefined {
  const json = extractFirstJsonObject(rawText);
  if (!json) return undefined;

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isStrictAgentOpinion(parsed)) return undefined;
    return normalizeAgentOutput(agent, role, json);
  } catch {
    return undefined;
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

function isDisposition(value: unknown): value is FindingDisposition {
  return (
    typeof value === "string" &&
    dispositions.includes(value as FindingDisposition)
  );
}

function isChangeRelation(value: unknown): value is ChangeRelation {
  return (
    typeof value === "string" &&
    changeRelations.includes(value as ChangeRelation)
  );
}

function isEvidenceQuality(value: unknown): value is EvidenceQuality {
  return (
    typeof value === "string" &&
    evidenceQualities.includes(value as EvidenceQuality)
  );
}

function isStrictAgentOpinion(
  value: unknown,
): value is Omit<NormalizedAgentOpinion, "agent" | "role"> {
  if (!isRecord(value) || !hasOnlyKeys(value, STRICT_ROOT_KEYS)) return false;
  if (typeof value.summary !== "string") return false;
  if (
    !Array.isArray(value.findings) ||
    !value.findings.every(isStrictFinding) ||
    !isStringArray(value.testsToAdd) ||
    !isStringArray(value.residualRisks) ||
    !isStringArray(value.openQuestions)
  ) {
    return false;
  }
  return (
    value.cisaSecureByDesign === undefined ||
    isStrictCisaSecureByDesign(value.cisaSecureByDesign)
  );
}

function isStrictFinding(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, STRICT_FINDING_KEYS)) {
    return false;
  }
  if (
    !isSeverity(value.severity) ||
    !isCategory(value.category) ||
    !isNonEmptyString(value.title) ||
    !isNonEmptyString(value.evidence) ||
    !isNonEmptyString(value.recommendation) ||
    !isConfidence(value.confidence)
  ) {
    return false;
  }
  if (
    (value.disposition !== undefined && !isDisposition(value.disposition)) ||
    (value.changeRelation !== undefined &&
      !isChangeRelation(value.changeRelation)) ||
    (value.evidenceQuality !== undefined &&
      !isEvidenceQuality(value.evidenceQuality)) ||
    (value.files !== undefined && !isStrictFindingFiles(value.files)) ||
    (value.evidenceRefs !== undefined &&
      !isStrictEvidenceRefs(value.evidenceRefs)) ||
    (value.cisaMapping !== undefined && !isStringArray(value.cisaMapping))
  ) {
    return false;
  }
  return true;
}

function isStrictFindingFiles(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        isRecord(item) &&
        hasOnlyKeys(item, STRICT_FILE_KEYS) &&
        isNonEmptyString(item.path) &&
        isOptionalLineNumber(item.lineStart) &&
        isOptionalLineNumber(item.lineEnd),
    )
  );
}

function isStrictEvidenceRefs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_EVIDENCE_REFS &&
    value.every((item) => {
      if (!isRecord(item) || !hasOnlyKeys(item, STRICT_EVIDENCE_REF_KEYS)) {
        return false;
      }
      if (
        item.kind !== "file" &&
        item.kind !== "diff_hunk" &&
        item.kind !== "plan_clause"
      ) {
        return false;
      }
      if (
        !isOptionalNonEmptyString(item.path) ||
        !isOptionalNonEmptyString(item.label) ||
        !isOptionalLineNumber(item.lineStart) ||
        !isOptionalLineNumber(item.lineEnd)
      ) {
        return false;
      }
      if (item.kind === "file" || item.kind === "diff_hunk") {
        return item.path !== undefined && item.lineStart !== undefined;
      }
      return item.label !== undefined || item.lineStart !== undefined;
    })
  );
}

function isStrictCisaSecureByDesign(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, STRICT_CISA_KEYS)) return false;
  for (const key of [
    "customerSecurityOutcomes",
    "secureByDefault",
    "transparencyAndAccountability",
    "governance",
  ] as const) {
    if (value[key] !== undefined && !normalizeGateStatus(value[key])) {
      return false;
    }
  }
  return value.notes === undefined || isStringArray(value.notes);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isOptionalLineNumber(value: unknown): boolean {
  return value === undefined || normalizeLineNumber(value) !== undefined;
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

function normalizeEvidenceRefs(value: unknown): EvidenceRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const references = value.slice(0, MAX_EVIDENCE_REFS).flatMap((item) => {
    if (
      !isRecord(item) ||
      (item.kind !== "file" &&
        item.kind !== "diff_hunk" &&
        item.kind !== "plan_clause")
    ) {
      return [];
    }
    const reference: EvidenceRef = { kind: item.kind };
    if (typeof item.path === "string" && item.path.trim().length > 0) {
      reference.path = sanitizeText(item.path);
    }
    const lineStart = normalizeLineNumber(item.lineStart);
    const lineEnd = normalizeLineNumber(item.lineEnd);
    if (lineStart !== undefined) reference.lineStart = lineStart;
    if (
      lineStart !== undefined &&
      lineEnd !== undefined &&
      lineEnd >= lineStart
    )
      reference.lineEnd = lineEnd;
    if (typeof item.label === "string" && item.label.trim().length > 0) {
      reference.label = sanitizeText(item.label);
    }
    return [reference];
  });
  return references.length > 0 ? references : undefined;
}

function normalizeLineNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_EVIDENCE_LINE
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
