import type { KyosoResult } from "../core/types.js";
import type { JudgeOutput } from "./provider.js";

export function runDeterministicJudge(
  result: Omit<KyosoResult, "summaryMarkdown">,
  summaryText: string,
): JudgeOutput {
  return {
    summaryText,
    disagreementComments: result.disagreements.map((disagreement) => ({
      topic: disagreement.topic,
      judgeComment: disagreement.judgeComment,
    })),
  };
}
