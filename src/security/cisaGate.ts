import type {
  AgentRunResult,
  CisaSecureByDesignResult,
  GateStatus,
  KyosoFinding,
} from "../core/types.js";

export type CisaGatePolicy = {
  enabled: boolean;
  gate: boolean;
  dimensions: {
    customerSecurityOutcomes: boolean;
    secureByDefault: boolean;
    transparencyAndAccountability: boolean;
    governance: boolean;
  };
};

const DEFAULT_POLICY: CisaGatePolicy = {
  enabled: true,
  gate: true,
  dimensions: {
    customerSecurityOutcomes: true,
    secureByDefault: true,
    transparencyAndAccountability: true,
    governance: true,
  },
};

export function computeCisaGate(
  findings: KyosoFinding[],
  agentResults: AgentRunResult[],
  policy: CisaGatePolicy = DEFAULT_POLICY,
): CisaSecureByDesignResult {
  const gate: CisaSecureByDesignResult = {
    gateEnabled: policy.gate,
    enabledDimensions: [
      ...(policy.dimensions.customerSecurityOutcomes
        ? (["customer_security_outcomes"] as const)
        : []),
      ...(policy.dimensions.secureByDefault
        ? (["secure_by_default"] as const)
        : []),
      ...(policy.dimensions.transparencyAndAccountability
        ? (["transparency_and_accountability"] as const)
        : []),
      ...(policy.dimensions.governance ? (["governance"] as const) : []),
    ],
    customerSecurityOutcomes: policy.dimensions.customerSecurityOutcomes
      ? "pass"
      : "not_applicable",
    secureByDefault: policy.dimensions.secureByDefault
      ? "pass"
      : "not_applicable",
    transparencyAndAccountability: policy.dimensions
      .transparencyAndAccountability
      ? "pass"
      : "not_applicable",
    governance: policy.dimensions.governance ? "pass" : "not_applicable",
    notes: [],
  };

  for (const result of agentResults) {
    const cisa = result.normalized?.cisaSecureByDesign;
    if (!cisa) continue;
    gate.notes.push(
      ...(cisa.notes ?? []).map((note) => `Agent-reported advisory: ${note}`),
    );
  }

  for (const finding of findings) {
    if (
      finding.disposition !== "gate" &&
      finding.disposition !== "actionable"
    ) {
      continue;
    }
    const status: GateStatus =
      finding.disposition === "gate" &&
      (finding.severity === "critical" || finding.severity === "high")
        ? "fail"
        : "warn";

    if (finding.category === "secret") {
      applyDimension(gate, policy, "customerSecurityOutcomes", status);
      applyDimension(
        gate,
        policy,
        "secureByDefault",
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
      applyDimension(gate, policy, "customerSecurityOutcomes", status);
      applyDimension(gate, policy, "secureByDefault", status);
    }
    if (
      finding.category === "test" ||
      finding.category === "cisa_secure_by_design"
    ) {
      applyDimension(
        gate,
        policy,
        "governance",
        status === "fail" ? "warn" : status,
      );
    }
    for (const mapping of finding.cisaMapping ?? []) {
      if (mapping === "customer_security_outcomes") {
        applyDimension(gate, policy, "customerSecurityOutcomes", status);
      }
      if (mapping === "secure_by_default") {
        applyDimension(gate, policy, "secureByDefault", status);
      }
      if (mapping === "transparency_and_accountability") {
        applyDimension(gate, policy, "transparencyAndAccountability", status);
      }
      if (mapping === "governance")
        applyDimension(gate, policy, "governance", status);
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

function applyDimension(
  gate: CisaSecureByDesignResult,
  policy: CisaGatePolicy,
  dimension: keyof CisaGatePolicy["dimensions"],
  status: GateStatus,
): void {
  if (!policy.dimensions[dimension]) return;
  gate[dimension] = worstGate(gate[dimension], status);
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
