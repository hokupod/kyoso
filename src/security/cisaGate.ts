import type {
  AgentRunResult,
  CisaSecureByDesignResult,
  GateStatus,
  KyosoFinding,
} from "../core/types.js";

export function computeCisaGate(
  findings: KyosoFinding[],
  agentResults: AgentRunResult[],
): CisaSecureByDesignResult {
  const gate: CisaSecureByDesignResult = {
    customerSecurityOutcomes: "pass",
    secureByDefault: "pass",
    transparencyAndAccountability: "pass",
    governance: "pass",
    notes: [],
  };

  for (const result of agentResults) {
    const cisa = result.normalized?.cisaSecureByDesign;
    if (!cisa) continue;
    if (cisa.customerSecurityOutcomes) {
      gate.customerSecurityOutcomes = worstGate(
        gate.customerSecurityOutcomes,
        cisa.customerSecurityOutcomes,
      );
    }
    if (cisa.secureByDefault) {
      gate.secureByDefault = worstGate(
        gate.secureByDefault,
        cisa.secureByDefault,
      );
    }
    if (cisa.transparencyAndAccountability) {
      gate.transparencyAndAccountability = worstGate(
        gate.transparencyAndAccountability,
        cisa.transparencyAndAccountability,
      );
    }
    if (cisa.governance)
      gate.governance = worstGate(gate.governance, cisa.governance);
    gate.notes.push(...(cisa.notes ?? []));
  }

  for (const finding of findings) {
    const status: GateStatus =
      finding.severity === "critical" || finding.severity === "high"
        ? "fail"
        : finding.severity === "medium" || finding.severity === "low"
          ? "warn"
          : "pass";

    if (finding.category === "secret") {
      gate.customerSecurityOutcomes = worstGate(
        gate.customerSecurityOutcomes,
        status,
      );
      gate.secureByDefault = worstGate(
        gate.secureByDefault,
        status === "fail" ? "warn" : status,
      );
      gate.notes.push(
        status === "fail"
          ? "Detected secret material was redacted and blocked before agent execution."
          : "Detected secret material was redacted before agent execution continued.",
      );
    }
    if (
      [
        "authn",
        "authz",
        "csrf",
        "xss",
        "ssrf",
        "injection",
        "privacy",
        "data_loss",
      ].includes(finding.category)
    ) {
      gate.customerSecurityOutcomes = worstGate(
        gate.customerSecurityOutcomes,
        status,
      );
      gate.secureByDefault = worstGate(gate.secureByDefault, status);
    }
    if (
      finding.category === "test" ||
      finding.category === "cisa_secure_by_design"
    ) {
      gate.governance = worstGate(
        gate.governance,
        status === "fail" ? "warn" : status,
      );
    }
    for (const mapping of finding.cisaMapping ?? []) {
      if (mapping === "customer_security_outcomes") {
        gate.customerSecurityOutcomes = worstGate(
          gate.customerSecurityOutcomes,
          status,
        );
      }
      if (mapping === "secure_by_default") {
        gate.secureByDefault = worstGate(gate.secureByDefault, status);
      }
      if (mapping === "transparency_and_accountability") {
        gate.transparencyAndAccountability = worstGate(
          gate.transparencyAndAccountability,
          status,
        );
      }
      if (mapping === "governance")
        gate.governance = worstGate(gate.governance, status);
    }
  }

  if (gate.notes.length === 0) {
    gate.notes.push(
      "No CISA Secure by Design gate failures were detected from the supplied context.",
    );
  }
  gate.notes = Array.from(new Set(gate.notes));
  return gate;
}

function worstGate(a: GateStatus, b: GateStatus): GateStatus {
  const score: Record<GateStatus, number> = {
    not_applicable: 0,
    pass: 1,
    warn: 2,
    fail: 3,
  };
  return score[a] >= score[b] ? a : b;
}
