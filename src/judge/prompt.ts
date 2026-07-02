import type { KyosoResult, ReviewTool } from "../core/types.js";
import { sanitizeText } from "../security/sanitizeText.js";

export function buildJudgePrompt(
  tool: ReviewTool,
  result: Omit<KyosoResult, "summaryMarkdown">,
  summaryText: string,
): string {
  return [
    "You are the Kyoso advisory judge.",
    "Rewrite only the Summary section body and add concise disagreement comments.",
    "Do not return or replace the full Markdown report.",
    "Do not change the decision, findings, CISA gate, file references, severities, tests, residual risks, or agent status.",
    "Return only JSON matching this schema:",
    `{"summaryText":"string","disagreementComments":[{"topic":"string","judgeComment":"string"}]}`,
    "",
    "Input:",
    JSON.stringify(
      {
        tool,
        decision: result.decision,
        degraded: result.degraded,
        summaryText,
        findings: result.findings,
        cisaSecureByDesign: result.cisaSecureByDesign,
        disagreements: result.disagreements,
        testsToAdd: result.testsToAdd,
        residualRisks: result.residualRisks,
        agentOpinions: result.agentOpinions.map((opinion) => ({
          agent: opinion.agent,
          role: opinion.role,
          summary: opinion.summary,
          status: opinion.status,
          errorCode: opinion.errorCode,
        })),
      },
      null,
      2,
    ),
  ].join("\n");
}

export function parseJudgeOutput(
  text: string,
  fallbackSummaryText: string,
): {
  summaryText: string;
  disagreementComments: Array<{ topic: string; judgeComment: string }>;
} {
  const json = extractFirstJsonObject(text);
  if (!json) throw new Error("Judge output did not contain a JSON object.");

  const parsed = JSON.parse(json) as Partial<{
    summaryText: unknown;
    disagreementComments: unknown;
  }>;
  const summaryText =
    typeof parsed.summaryText === "string" &&
    parsed.summaryText.trim().length > 0
      ? sanitizeText(parsed.summaryText)
      : fallbackSummaryText;
  const disagreementComments = Array.isArray(parsed.disagreementComments)
    ? parsed.disagreementComments.flatMap((item) => {
        if (
          !isRecord(item) ||
          typeof item.topic !== "string" ||
          typeof item.judgeComment !== "string"
        ) {
          return [];
        }
        return [
          {
            topic: sanitizeText(item.topic),
            judgeComment: sanitizeText(item.judgeComment),
          },
        ];
      })
    : [];

  return { summaryText, disagreementComments };
}

function extractFirstJsonObject(text: string): string | undefined {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
