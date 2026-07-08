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
    `**Agents:** ${result.agentOpinions.map((opinion) => `${title(opinion.agent)} ${opinion.status}`).join(", ")}`,
    `**Review mode:** ${formatReviewMode(result)}`,
    `**Degraded:** ${String(result.degraded)}`,
    "",
    "## Summary",
    "",
    options.summaryText ?? defaultSummaryText(result),
  ];

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
  return result.findings.length === 0
    ? "No blocking findings were detected from the supplied context."
    : `${result.findings.length} finding(s) require attention.`;
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

function formatList(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}
