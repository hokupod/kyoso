import * as z from "zod/v4";

export const kyosoReviewRequestSchema = z.object({
  goal: z.string().min(1),
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
      includeAgentRawOutputs: z.boolean().optional(),
      judgeProvider: z.enum(["auto", "openai", "anthropic", "none"]).optional(),
      allowSecretRedaction: z.boolean().optional(),
    })
    .optional(),
});
