import type { KyosoResult, ReviewTool } from "../core/types.js";

type MarkdownRenderOptions = {
  summaryText?: string;
};

export function renderMarkdownResult(
  tool: ReviewTool,
  result: Omit<KyosoResult, "summaryMarkdown">,
  options: MarkdownRenderOptions = {},
): string {
  const lines: string[] = [
    "# Kyoso Review Result",
    "",
    `**Decision:** ${result.decision}`,
    `**Mode:** ${tool}`,
    `**Completion:** ${formatCompletion(result)}`,
    `**Request fingerprint:** ${shortFingerprint(result.requestFingerprint)}`,
    `**Agents:** ${result.agentOpinions.map((opinion) => `${title(opinion.agent)} ${opinion.status}`).join(", ")}`,
    `**Review mode:** ${formatReviewMode(result)}`,
    ...(result.verificationMode
      ? [
          `**Verification mode:** ${formatVerificationMode(result.verificationMode)}`,
        ]
      : []),
    `**Degraded:** ${String(result.degraded)}`,
    "",
    "## Summary",
    "",
    options.summaryText ?? defaultSummaryText(result),
  ];

  lines.push(...formatExecutionBudget(result));

  if (result.cisaSecureByDesign) {
    lines.push(
      "",
      "## CISA Secure by Design Gate",
      "",
      "| Dimension | Status | Notes |",
      "|---|---|---|",
      `| Customer Security Outcomes | ${result.cisaSecureByDesign.customerSecurityOutcomes} | ${notes(result.cisaSecureByDesign.notes)} |`,
      `| Secure by Default | ${result.cisaSecureByDesign.secureByDefault} | ${notes(result.cisaSecureByDesign.notes)} |`,
      `| Transparency & Accountability | ${result.cisaSecureByDesign.transparencyAndAccountability} | ${notes(result.cisaSecureByDesign.notes)} |`,
      `| Governance | ${result.cisaSecureByDesign.governance} | ${notes(result.cisaSecureByDesign.notes)} |`,
    );
  }

  lines.push("", "## Findings", "");
  if (result.findings.length === 0) {
    lines.push("- None.");
  } else {
    for (const finding of result.findings) {
      lines.push(
        `### ${finding.severity.toUpperCase()}: ${finding.title}`,
        "",
        `Evidence: ${finding.evidence}`,
        "",
        `Recommendation: ${finding.recommendation}`,
        "",
        `Files: ${formatFiles(finding.files)}`,
      );
      if (result.reviewMode !== "single_agent" && finding.crossValidation) {
        lines.push(
          "",
          `Cross-validation: ${formatCrossValidation(finding.crossValidation)}`,
        );
      }
      if (finding.verification) {
        lines.push("", `Verification: ${formatVerification(finding)}`);
      }
      lines.push("");
    }
  }

  lines.push("", "## Tests to Add", "");
  lines.push(
    ...(result.testsToAdd.length > 0
      ? result.testsToAdd.map((test) => `- ${test}`)
      : ["- None."]),
  );

  lines.push("", "## Residual Risks", "");
  lines.push(
    ...(result.residualRisks.length > 0
      ? result.residualRisks.map((risk) => `- ${risk}`)
      : ["- None."]),
  );

  if (result.audit.warnings && result.audit.warnings.length > 0) {
    lines.push("", "## Warnings", "");
    lines.push(
      ...result.audit.warnings.map(
        (warning) => `- ${escapeMarkdownText(warning)}`,
      ),
    );
  }

  if (result.crossModelAnalysis) {
    lines.push("", "## Cross-Model Analysis", "");
    if (result.reviewMode === "single_agent") {
      lines.push("- not available (single agent)");
    } else {
      lines.push(
        `Provider: ${result.crossModelAnalysis.provider}`,
        "",
        "Blind spots (advisory; does not affect the decision):",
        ...formatList(result.crossModelAnalysis.blindSpots),
        "",
        "Contradictions:",
        ...formatList(
          result.crossModelAnalysis.contradictions.map(
            (item) => `${item.topic}: ${item.detail}`,
          ),
        ),
        "",
        "Partial coverage:",
        ...formatList(
          result.crossModelAnalysis.partialCoverage.map((item) =>
            item.findingId ? `${item.findingId}: ${item.note}` : item.note,
          ),
        ),
      );
    }
  }

  lines.push("", "## Agent Opinions", "");
  for (const opinion of result.agentOpinions) {
    lines.push(
      `### ${title(opinion.agent)}`,
      "",
      `${opinion.summary} (${opinion.status})`,
      "",
    );
  }

  lines.push("", "## Disagreements", "");
  if (result.reviewMode === "single_agent") {
    lines.push("- N/A - single-agent review.");
  } else {
    lines.push(
      ...(result.disagreements.length > 0
        ? result.disagreements.map(
            (item) => `- ${item.topic}: ${item.judgeComment}`,
          )
        : ["- None."]),
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "Kyoso did not modify files. Review was performed on a temporary snapshot.",
  );
  if (result.audit.networkMode === "unrestricted") {
    lines.push(
      "Network mode was unrestricted. File modification policy remained denied.",
    );
  }
  return lines.join("\n");
}

export function defaultSummaryText(
  result: Omit<KyosoResult, "summaryMarkdown">,
): string {
  if (result.completion.status === "incomplete") {
    const reasons =
      result.completion.reasons.length > 0
        ? result.completion.reasons.join(", ")
        : "unspecified coverage gap";
    return `Review incomplete (${reasons}). Decision is block because review coverage is incomplete, not because a code finding was established.`;
  }
  return result.findings.length === 0
    ? "No blocking findings were detected from the supplied context."
    : `${result.findings.length} finding(s) require attention.`;
}

function formatExecutionBudget(
  result: Omit<KyosoResult, "summaryMarkdown">,
): string[] {
  const budget = result.executionBudget;
  const agentOutputs = Object.entries(budget.agentOutputBytes);
  const outputLines =
    agentOutputs.length > 0
      ? agentOutputs.map(
          ([agent, bytes]) => `- ${title(agent)}: ${bytes} bytes`,
        )
      : ["- None reported."];
  const totalTokens = budget.tokenUsage.totals.totalTokens;
  return [
    "",
    "## Execution Budget",
    "",
    `- Model calls: ${budget.modelCalls.planned} planned / ${budget.modelCalls.consumed} consumed / ${budget.modelCalls.skipped} skipped`,
    `- Wall time: ${budget.wallTime.consumedMs}ms consumed / ${budget.wallTime.limitMs}ms limit`,
    `- Token usage: ${budget.tokenUsage.status} (${budget.tokenUsage.reportedCalls} reported, ${budget.tokenUsage.unknownCalls} unknown${totalTokens === undefined ? "" : `, ${totalTokens} total`})`,
    "- Agent output:",
    ...outputLines,
  ];
}

function formatCompletion(
  result: Omit<KyosoResult, "summaryMarkdown">,
): string {
  if (result.completion.status === "complete") return "complete";
  const reasons = result.completion.reasons.join(", ") || "unspecified";
  return `incomplete (${reasons}; retryable=${String(result.completion.retryable)})`;
}

function shortFingerprint(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 20)}…`;
}

function title(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatReviewMode(
  result: Omit<KyosoResult, "summaryMarkdown">,
): string {
  if (result.reviewMode !== "single_agent") return "multi-agent";
  const opinion = result.agentOpinions[0];
  const agent = opinion ? title(opinion.agent) : "single agent";
  const role =
    opinion?.role === "combined_reviewer" ? "combined role" : "configured role";
  return `single-agent (${agent}, ${role}; cross-model verification was not performed)`;
}

function notes(items: string[]): string {
  return (items[0] ?? "No notes.").replaceAll("|", "\\|");
}

function formatFiles(files: KyosoResult["findings"][number]["files"]): string {
  if (!files?.length) return "n/a";
  return files
    .map(
      (file) => `\`${file.path}${file.lineStart ? `:${file.lineStart}` : ""}\``,
    )
    .join(", ");
}

function formatCrossValidation(
  crossValidation: NonNullable<
    KyosoResult["findings"][number]["crossValidation"]
  >,
): string {
  return crossValidation === "corroborated" ? "corroborated" : "single-source";
}

function formatVerificationMode(
  verificationMode: NonNullable<KyosoResult["verificationMode"]>,
): string {
  return verificationMode === "cross_agent"
    ? "cross-agent"
    : "skipped (single-agent)";
}

function formatVerification(finding: KyosoResult["findings"][number]): string {
  const verification = finding.verification;
  if (!verification) return "n/a";
  const verifier = verification.verifier
    ? ` by ${title(verification.verifier)}`
    : "";
  const note = verification.note ? ` - ${verification.note}` : "";
  return `${verification.status}${verifier}${note}`;
}

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\`*_{}\[\]()#+!|])/g, "\\$1");
}
