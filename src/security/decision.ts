import type {
  CisaSecureByDesignResult,
  KyosoDecision,
  KyosoFinding,
  ReviewTool,
  SecretScanResult,
} from "../core/types.js";

export function decide(input: {
  tool: ReviewTool;
  findings: KyosoFinding[];
  cisa?: CisaSecureByDesignResult;
  degraded: boolean;
  secretScan: Pick<SecretScanResult, "detected"> & { blocked: boolean };
}): KyosoDecision {
  if (input.secretScan.detected && input.secretScan.blocked) return "block";
  if (input.findings.some((finding) => finding.severity === "critical")) return "block";
  if (input.cisa?.customerSecurityOutcomes === "fail") return "block";

  if (input.tool === "security_review" && input.degraded) {
    if (input.findings.some((finding) => finding.severity === "high")) return "block";
    return "approve_with_changes";
  }

  if (input.cisa?.secureByDefault === "fail") return "approve_with_changes";
  if (input.findings.some((finding) => finding.severity === "high")) return "approve_with_changes";
  if (input.findings.some((finding) => finding.severity === "medium")) return "approve_with_changes";
  return "approve";
}
