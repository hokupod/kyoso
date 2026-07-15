import { extractFirstJsonObject } from "../acp/normalize.js";
import { compareSeverity } from "../aggregate/severity.js";
import { sanitizeText } from "../security/sanitizeText.js";
import type { AgentName, KyosoFinding } from "./types.js";

export type VerificationVerdict = {
  findingId: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  reasoning: string;
  evidence: string;
};

export type VerificationTarget = {
  finding: KyosoFinding;
  verifier: AgentName;
};

export type VerificationSelection = {
  selected: VerificationTarget[];
  overflow: VerificationTarget[];
};

const REAL_AGENTS: AgentName[] = ["codex", "claude"];
const VERIFIABLE_SEVERITIES = new Set(["critical", "high"]);

export function selectVerificationTargets(
  findings: KyosoFinding[],
  maxFindings: number,
): VerificationSelection {
  const candidates = findings.flatMap((finding, index) => {
    if (finding.crossValidation !== "single_source") return [];
    if (!VERIFIABLE_SEVERITIES.has(finding.severity)) return [];
    const verifier = verifierForFinding(finding);
    if (!verifier) return [];
    return [{ finding, verifier, index }];
  });

  const sorted = candidates.sort((a, b) => {
    const severity = compareSeverity(a.finding.severity, b.finding.severity);
    return severity === 0 ? a.index - b.index : severity;
  });
  const limit = Math.max(0, Math.floor(maxFindings));
  const selected = sorted.slice(0, limit).map(({ finding, verifier }) => ({
    finding,
    verifier,
  }));
  const overflow = sorted.slice(limit).map(({ finding, verifier }) => ({
    finding,
    verifier,
  }));
  return { selected, overflow };
}

export function groupVerificationTargetsByVerifier(
  targets: VerificationTarget[],
): Array<{ verifier: AgentName; findings: KyosoFinding[] }> {
  const groups = new Map<AgentName, KyosoFinding[]>();
  for (const target of targets) {
    const findings = groups.get(target.verifier) ?? [];
    findings.push(target.finding);
    groups.set(target.verifier, findings);
  }
  return Array.from(groups.entries()).map(([verifier, findings]) => ({
    verifier,
    findings,
  }));
}

export function markVerificationOverflow(
  targets: VerificationTarget[],
  reason?: string,
): void {
  for (const target of targets) {
    target.finding.verification = {
      status: "not_verified",
      ...(reason ? { note: reason } : {}),
    };
  }
}

export function parseVerificationVerdicts(
  rawText: string | undefined,
): VerificationVerdict[] | undefined {
  const json = rawText ? extractFirstJsonObject(rawText) : undefined;
  if (!json) return undefined;

  try {
    const parsed = JSON.parse(json) as { verdicts?: unknown };
    if (!Array.isArray(parsed.verdicts)) return undefined;
    return parsed.verdicts.flatMap((item): VerificationVerdict[] => {
      if (!isRecord(item)) return [];
      if (typeof item.findingId !== "string") return [];
      if (!isVerdict(item.verdict)) return [];
      return [
        {
          findingId: item.findingId,
          verdict: item.verdict,
          reasoning: typeof item.reasoning === "string" ? item.reasoning : "",
          evidence: typeof item.evidence === "string" ? item.evidence : "",
        },
      ];
    });
  } catch {
    return undefined;
  }
}

export function applyVerificationVerdicts(
  targets: VerificationTarget[],
  verifier: AgentName,
  verdicts: VerificationVerdict[] | undefined,
): Record<"confirmed" | "refuted" | "uncertain", number> {
  const counts = { confirmed: 0, refuted: 0, uncertain: 0 };
  const verdictByFinding = new Map<string, VerificationVerdict>();
  for (const verdict of verdicts ?? []) {
    verdictByFinding.set(verdict.findingId, verdict);
  }

  for (const target of targets.filter((item) => item.verifier === verifier)) {
    const verdict = verdictByFinding.get(target.finding.id);
    if (!verdict) {
      target.finding.verification = { status: "uncertain", verifier };
      counts.uncertain += 1;
      continue;
    }

    if (verdict.verdict === "confirmed") {
      target.finding.confidence = "high";
      target.finding.verification = { status: "confirmed", verifier };
      counts.confirmed += 1;
      continue;
    }

    if (verdict.verdict === "refuted") {
      target.finding.confidence = "low";
      target.finding.verification = {
        status: "refuted",
        verifier,
        note: verificationNote(verdict.reasoning),
      };
      counts.refuted += 1;
      continue;
    }

    target.finding.verification = { status: "uncertain", verifier };
    counts.uncertain += 1;
  }

  return counts;
}

export function countVerificationStatuses(
  findings: KyosoFinding[],
): Record<"confirmed" | "refuted" | "uncertain" | "not_verified", number> {
  const counts = {
    confirmed: 0,
    refuted: 0,
    uncertain: 0,
    not_verified: 0,
  };
  for (const finding of findings) {
    if (finding.verification) counts[finding.verification.status] += 1;
  }
  return counts;
}

function verifierForFinding(finding: KyosoFinding): AgentName | undefined {
  const sources = new Set(
    finding.sourceAgents.filter((source): source is AgentName =>
      REAL_AGENTS.includes(source as AgentName),
    ),
  );
  if (sources.size !== 1) return undefined;
  return REAL_AGENTS.find((agent) => !sources.has(agent));
}

function verificationNote(reasoning: string): string {
  return sanitizeText(reasoning).slice(0, 300);
}

function isVerdict(value: unknown): value is VerificationVerdict["verdict"] {
  return value === "confirmed" || value === "refuted" || value === "uncertain";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
