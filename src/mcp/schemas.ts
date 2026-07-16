import * as z from "zod/v4";
import { REVIEW_LENSES } from "../core/reviewPolicy.js";

export const kyosoReviewRequestSchema = z.object({
  goal: z.string().min(1),
  reviewContract: z
    .object({
      focus: z
        .array(z.enum(REVIEW_LENSES))
        .max(REVIEW_LENSES.length)
        .optional(),
      nonGoals: z.array(z.string().min(1).max(500)).max(20).optional(),
      acceptedRisks: z
        .array(
          z.object({
            findingFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
            rationale: z.string().min(1).max(500),
          }),
        )
        .max(20)
        .optional(),
    })
    .strict()
    .optional(),
  repoSummary: z.string().optional(),
  currentPlan: z.string().optional(),
  selectedFiles: z
    .array(
      z.object({
        path: z.string(),
        language: z.string().optional(),
        content: z.string(),
        truncated: z.boolean().optional(),
      }),
    )
    .optional(),
  diff: z
    .object({
      baseRef: z.string().optional(),
      headRef: z.string().optional(),
      unifiedDiff: z.string(),
    })
    .optional(),
  constraints: z.array(z.string()).optional(),
  workspace: z
    .object({
      root: z.string().optional(),
      allowRead: z.array(z.string()).optional(),
      denyRead: z.array(z.string()).optional(),
    })
    .optional(),
  options: z
    .object({
      network: z.enum(["model_only", "unrestricted"]).optional(),
      maxAgentTimeoutMs: z.number().int().positive().optional(),
      reviewBudget: z
        .object({
          maxModelCalls: z.number().int().positive().optional(),
          maxTotalWallTimeMs: z.number().int().positive().optional(),
          maxAgentOutputBytes: z.number().int().positive().optional(),
          maxFindingsPerAgent: z.number().int().positive().optional(),
          skipOptionalPhasesWhenTokenUsageUnknown: z.boolean().optional(),
        })
        .strict()
        .optional(),
      includeAgentRawOutputs: z.boolean().optional(),
      judgeProvider: z.enum(["auto", "openai", "anthropic", "none"]).optional(),
      allowSecretRedaction: z.boolean().optional(),
    })
    .optional(),
});
