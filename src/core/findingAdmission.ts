import { createHash } from "node:crypto";
import type {
  ChangeRelation,
  EvidenceQuality,
  EvidenceRef,
  FindingCategory,
  FindingDisposition,
  KyosoFinding,
  KyosoReviewRequest,
  ReviewMode,
  ReviewTool,
} from "./types.js";

const SAFETY_CATEGORIES = new Set<FindingCategory>([
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
]);
const MAX_EVIDENCE_REFS = 20;
const MAX_EVIDENCE_LINE = 1_000_000;

export function admitFindings(input: {
  tool: ReviewTool;
  request: KyosoReviewRequest;
  findings: KyosoFinding[];
  reviewMode: ReviewMode;
}): KyosoFinding[] {
  const diffLines = changedDiffLines(input.request.diff?.unifiedDiff);
  return input.findings.map((finding) => {
    const candidatePolicyReasons = [...finding.policyReasons];
    const evidenceRefs = normalizeEvidenceRefs(finding);
    const fingerprint = findingFingerprint(finding, evidenceRefs);
    const evidenceQuality = determineEvidenceQuality(
      finding,
      evidenceRefs,
      input.request,
      diffLines,
    );
    const changeRelation = determineChangeRelation(
      finding.changeRelation,
      evidenceRefs,
      input.tool,
      input.request,
      diffLines,
    );
    const acceptedRisk = input.request.reviewContract?.acceptedRisks?.find(
      (risk) => risk.findingFingerprint === fingerprint,
    );
    const matchedNonGoal = input.request.reviewContract?.nonGoals?.find(
      (nonGoal) =>
        candidatePolicyReasons.includes(nonGoal) ||
        candidatePolicyReasons.includes(`non_goal:${nonGoal}`),
    );
    const policyReasons: string[] = [];

    if (acceptedRisk) {
      policyReasons.push(`accepted_risk: ${acceptedRisk.rationale}`);
    }
    if (matchedNonGoal) policyReasons.push(`non_goal: ${matchedNonGoal}`);

    const disposition = determineDisposition({
      finding,
      evidenceQuality,
      changeRelation,
      reviewMode: input.reviewMode,
      acceptedRisk: acceptedRisk !== undefined,
      matchedNonGoal: matchedNonGoal !== undefined,
      policyReasons,
    });

    return {
      ...finding,
      disposition,
      changeRelation,
      evidenceQuality,
      evidenceRefs,
      policyReasons: Array.from(new Set(policyReasons)),
      fingerprint,
    };
  });
}

export function selectRegressionTests(tests: string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of tests) {
    const test = candidate.trim();
    const identity = test.toLowerCase().replace(/\s+/g, " ");
    if (
      seen.has(identity) ||
      isGenericTestRecommendation(test) ||
      selected.length >= 3
    ) {
      continue;
    }
    seen.add(identity);
    selected.push(test);
  }
  return selected;
}

export function buildAdmissionOpenQuestions(
  findings: KyosoFinding[],
): string[] {
  return findings.flatMap((finding) => {
    if (finding.evidenceQuality === "concrete") return [];
    return [
      `${finding.title}: identify a concrete file/line, diff hunk, or plan clause and the resulting failure path.`,
    ];
  });
}

export function findingFingerprint(
  finding: Pick<KyosoFinding, "category" | "title">,
  evidenceRefs: EvidenceRef[],
): string {
  const payload = JSON.stringify({
    category: finding.category,
    title: normalizeIdentityText(finding.title),
    evidenceRefs: evidenceRefs
      .map((reference) => ({
        kind: reference.kind,
        path: reference.path ?? null,
        lineStart: reference.lineStart ?? null,
        lineEnd: reference.lineEnd ?? null,
        label: reference.label ? normalizeIdentityText(reference.label) : null,
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
  });
  return `sha256:${createHash("sha256").update(payload, "utf8").digest("hex")}`;
}

function determineDisposition(input: {
  finding: KyosoFinding;
  evidenceQuality: EvidenceQuality;
  changeRelation: ChangeRelation;
  reviewMode: ReviewMode;
  acceptedRisk: boolean;
  matchedNonGoal: boolean;
  policyReasons: string[];
}): FindingDisposition {
  const { finding } = input;
  if (finding.sourceAgents.includes("kyoso_policy")) {
    input.policyReasons.push("kyoso_policy");
    if (finding.severity === "critical" || finding.severity === "high") {
      return "gate";
    }
    return finding.severity === "medium" ? "actionable" : "advisory";
  }

  const highSeverity =
    finding.severity === "critical" || finding.severity === "high";
  const safetyFinding = SAFETY_CATEGORIES.has(finding.category);
  if (isOptionalOrStyleFinding(finding) && !(highSeverity && safetyFinding)) {
    input.policyReasons.push("optional_or_style");
    return "advisory";
  }
  if (finding.severity === "low" || finding.severity === "info") {
    input.policyReasons.push("low_or_info_severity");
    return "advisory";
  }

  if (highSeverity) {
    if (input.acceptedRisk)
      input.policyReasons.push("high_risk_not_suppressed");
    if (input.matchedNonGoal)
      input.policyReasons.push("high_non_goal_not_suppressed");
    if (finding.verification?.status === "refuted") {
      input.policyReasons.push("verification_refuted");
      return "disputed";
    }
    if (finding.confidence === "low") {
      input.policyReasons.push("low_confidence_high_severity");
      return "disputed";
    }
    if (
      input.reviewMode === "multi_agent" &&
      finding.crossValidation === "single_source" &&
      finding.verification?.status !== "confirmed"
    ) {
      input.policyReasons.push("model_disagreement");
      return "disputed";
    }
    if (input.evidenceQuality !== "concrete") {
      input.policyReasons.push("insufficient_evidence");
      return "disputed";
    }
    if (
      input.changeRelation !== "introduced" &&
      input.changeRelation !== "worsened"
    ) {
      input.policyReasons.push(
        input.changeRelation === "pre_existing"
          ? "pre_existing_high_severity"
          : "unknown_change_relation",
      );
      return "disputed";
    }
    input.policyReasons.push("concrete_changed_high_severity");
    return "gate";
  }

  if (input.acceptedRisk) return "advisory";
  if (input.matchedNonGoal) return "advisory";
  if (input.changeRelation === "pre_existing") {
    input.policyReasons.push("pre_existing_medium");
    return "advisory";
  }
  if (input.evidenceQuality !== "concrete") {
    input.policyReasons.push("insufficient_evidence");
    return "advisory";
  }
  if (
    input.changeRelation !== "introduced" &&
    input.changeRelation !== "worsened"
  ) {
    input.policyReasons.push("unknown_change_relation");
    return "advisory";
  }
  input.policyReasons.push("concrete_changed_medium");
  return "actionable";
}

function determineEvidenceQuality(
  finding: KyosoFinding,
  references: EvidenceRef[],
  request: KyosoReviewRequest,
  diffLines: Map<string, Set<number>>,
): EvidenceQuality {
  if (finding.sourceAgents.includes("kyoso_policy")) return "concrete";
  const evidence = finding.evidence.trim();
  const recommendation = finding.recommendation.trim();
  const hasSpecificText =
    evidence.length >= 20 &&
    recommendation.length >= 10 &&
    !/^no evidence provided\.?$/i.test(evidence) &&
    !/^review manually\.?$/i.test(recommendation);
  if (!hasSpecificText || references.length === 0) return "insufficient";
  return references.some((reference) =>
    referenceExists(reference, request, diffLines),
  )
    ? "concrete"
    : "partial";
}

function determineChangeRelation(
  candidate: ChangeRelation,
  references: EvidenceRef[],
  tool: ReviewTool,
  request: KyosoReviewRequest,
  diffLines: Map<string, Set<number>>,
): ChangeRelation {
  const changedReference = references.some((reference) =>
    overlapsChangedDiff(reference, diffLines),
  );
  if (changedReference) {
    return candidate === "worsened" ? "worsened" : "introduced";
  }

  const planReference = references.some(
    (reference) =>
      tool !== "diff_review" &&
      reference.kind === "plan_clause" &&
      referenceExists(reference, request, diffLines),
  );
  if (planReference) {
    return candidate === "worsened" ? "worsened" : "introduced";
  }

  if (
    candidate === "pre_existing" &&
    references.some(
      (reference) =>
        reference.kind === "file" &&
        referenceExists(reference, request, diffLines),
    )
  ) {
    return "pre_existing";
  }
  return "unknown";
}

function normalizeEvidenceRefs(finding: KyosoFinding): EvidenceRef[] {
  const candidates =
    finding.evidenceRefs.length > 0
      ? finding.evidenceRefs
      : (finding.files ?? []).map((file): EvidenceRef => ({
          kind: "file",
          ...file,
        }));
  const references = candidates
    .slice(0, MAX_EVIDENCE_REFS)
    .flatMap((reference) => {
      const path = reference.path?.trim();
      const label = reference.label?.trim();
      const lineStart = validLine(reference.lineStart);
      const candidateLineEnd = validLine(reference.lineEnd);
      const lineEnd =
        lineStart !== undefined &&
        candidateLineEnd !== undefined &&
        candidateLineEnd >= lineStart
          ? candidateLineEnd
          : undefined;
      if (
        reference.kind === "plan_clause" &&
        !label &&
        lineStart === undefined
      ) {
        return [];
      }
      if (
        reference.kind !== "plan_clause" &&
        (!path || lineStart === undefined)
      ) {
        return [];
      }
      return [
        {
          kind: reference.kind,
          ...(path ? { path: normalizePath(path) } : {}),
          ...(lineStart !== undefined ? { lineStart } : {}),
          ...(lineEnd !== undefined ? { lineEnd } : {}),
          ...(label ? { label } : {}),
        },
      ];
    });
  const unique = new Map(
    references.map((reference) => [JSON.stringify(reference), reference]),
  );
  return Array.from(unique.values());
}

function referenceExists(
  reference: EvidenceRef,
  request: KyosoReviewRequest,
  diffLines: Map<string, Set<number>>,
): boolean {
  if (reference.kind === "plan_clause") {
    const plan = request.currentPlan;
    if (!plan) return false;
    if (reference.label && plan.includes(reference.label)) return true;
    return lineWithinText(reference.lineStart, plan);
  }
  if (!reference.path || reference.lineStart === undefined) return false;
  if (reference.kind === "diff_hunk") {
    return overlapsChangedDiff(reference, diffLines);
  }
  const selected = request.selectedFiles?.find(
    (file) => normalizePath(file.path) === normalizePath(reference.path ?? ""),
  );
  if (selected && lineWithinText(reference.lineStart, selected.content))
    return true;
  return diffLines.has(normalizePath(reference.path));
}

function overlapsChangedDiff(
  reference: EvidenceRef,
  diffLines: Map<string, Set<number>>,
): boolean {
  if (!reference.path || reference.lineStart === undefined) return false;
  const changed = diffLines.get(normalizePath(reference.path));
  if (!changed) return false;
  const end = reference.lineEnd ?? reference.lineStart;
  for (const line of changed) {
    if (line >= reference.lineStart && line <= end) return true;
  }
  return false;
}

function changedDiffLines(diff: string | undefined): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>();
  if (!diff) return changed;
  let path: string | undefined;
  let newLine: number | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).split("\t", 1)[0] ?? "";
      path = rawPath === "/dev/null" ? undefined : normalizePath(rawPath);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!path || newLine === undefined || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      const lines = changed.get(path) ?? new Set<number>();
      lines.add(newLine);
      changed.set(path, lines);
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      const lines = changed.get(path) ?? new Set<number>();
      lines.add(newLine);
      changed.set(path, lines);
      continue;
    }
    newLine += 1;
  }
  return changed;
}

function isOptionalOrStyleFinding(finding: KyosoFinding): boolean {
  const text = `${finding.title}\n${finding.evidence}\n${finding.recommendation}`;
  return /(?:format(?:ting)?|whitespace|naming preference|style-only|optional hardening|future hardening|defen[cs]e[- ]in[- ]depth only|cosmetic|命名|空白|整形のみ|任意のhardening)/i.test(
    text,
  );
}

function isGenericTestRecommendation(test: string): boolean {
  const normalized = test.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    /^(?:add|write|include|increase) (?:more )?(?:unit |integration |regression |security )?tests?\.?$/.test(
      normalized,
    ) ||
    /^(?:improve|increase) (?:test )?coverage\.?$/.test(normalized) ||
    /^(?:run|execute) (?:the )?(?:(?:full|entire|complete) (?:test )?suite|all tests?)\.?$/.test(
      normalized,
    ) ||
    /^(?:ensure|verify|confirm)(?: that)? (?:all )?tests? pass\.?$/.test(
      normalized,
    ) ||
    /^(?:テストを追加|テストを増やす|全テストを実行|テストスイートを実行)[。.]?$/.test(
      normalized,
    ) ||
    /^(?:添加更多测试|增加测试|运行所有测试|运行完整测试套件)[。.]?$/.test(
      normalized,
    )
  );
}

function lineWithinText(line: number | undefined, text: string): boolean {
  return line !== undefined && line <= Math.max(1, text.split("\n").length);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:a|b)\//, "");
}

function validLine(value: number | undefined): number | undefined {
  return value !== undefined &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_EVIDENCE_LINE
    ? value
    : undefined;
}

function normalizeIdentityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
