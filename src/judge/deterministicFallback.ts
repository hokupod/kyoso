import type { KyosoResult } from "../core/types.js";
import type { JudgeOutput } from "./provider.js";

export function runDeterministicJudge(result: KyosoResult): JudgeOutput {
  return {
    summaryMarkdown: result.summaryMarkdown,
    disagreementComments: result.disagreements.map((disagreement) => ({
      topic: disagreement.topic,
      judgeComment: disagreement.judgeComment,
    })),
  };
}
