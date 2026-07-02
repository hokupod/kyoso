import type { KyosoReviewRequest, ReviewTool } from "../core/types.js";

export function buildAgentPrompt(tool: ReviewTool, request: KyosoReviewRequest, agent: "codex" | "claude"): string {
  const shared = [
    "You are running as a Kyoso child reviewer.",
    "Do not edit files.",
    "Do not run shell commands.",
    "Do not request permission to modify files.",
    "Review only the provided context and return structured review output.",
    "If information is insufficient, say so and lower confidence.",
    "Return JSON first, then optional Markdown notes.",
  ].join("\n");

  const role =
    agent === "codex"
      ? [
          "You are the Codex implementation reviewer in Kyoso.",
          "Focus on feasibility, minimal change, existing code consistency, regression risk, tests, migration risk, and maintainability.",
        ].join("\n")
      : [
          "You are the Claude architecture and security reviewer in Kyoso.",
          "Focus on architecture, threat modeling, authn/authz, secrets, privacy, secure defaults, CISA Secure by Design, and edge cases.",
        ].join("\n");

  return `${shared}

${role}

Tool: ${tool}
Review goal:
${request.goal}

Context:
${renderRequestContext(request)}

Return JSON matching KyosoAgentOpinion:
{
  "summary": "string",
  "findings": [],
  "testsToAdd": [],
  "residualRisks": [],
  "openQuestions": []
}
`;
}

function renderRequestContext(request: KyosoReviewRequest): string {
  const chunks: string[] = [];
  if (request.repoSummary) chunks.push(`Repo summary:\n${request.repoSummary}`);
  if (request.currentPlan) chunks.push(`Current plan:\n${request.currentPlan}`);
  if (request.constraints?.length) chunks.push(`Constraints:\n${request.constraints.map((item) => `- ${item}`).join("\n")}`);
  if (request.diff?.unifiedDiff) chunks.push(`Unified diff:\n${request.diff.unifiedDiff}`);
  if (request.selectedFiles?.length) {
    chunks.push(
      `Selected files:\n${request.selectedFiles
        .map((file) => `--- ${file.path}${file.truncated ? " (truncated)" : ""}\n${file.content}`)
        .join("\n\n")}`,
    );
  }
  return chunks.length > 0 ? chunks.join("\n\n") : "Only the goal was provided. Return low-confidence findings if needed.";
}
