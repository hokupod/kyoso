import type { KyosoConfig } from "../config/schema.js";
import type {
  AgentName,
  CrossModelAnalysis,
  KyosoResult,
  JudgeProvider,
  NormalizedAgentOpinion,
  ReviewTool,
} from "../core/types.js";
import { runAnthropicJudge } from "./anthropic.js";
import { runDeterministicJudge } from "./deterministicFallback.js";
import { runOpenAiJudge } from "./openai.js";

export type JudgeOutput = {
  summaryText: string;
  disagreementComments: Array<{ topic: string; judgeComment: string }>;
  analysis?: Omit<CrossModelAnalysis, "provider">;
};

export type ResolvedJudgeProvider =
  Exclude<JudgeProvider, "auto"> | "deterministic_fallback";

export type JudgeRunResult = {
  provider: ResolvedJudgeProvider;
  status: "completed" | "deterministic_fallback" | "failed_fallback";
  output: JudgeOutput;
  error?: string;
};

export type JudgeRunInput = {
  tool: ReviewTool;
  result: Omit<KyosoResult, "summaryMarkdown">;
  summaryText: string;
  agentFindings: Array<{
    agent: AgentName;
    role: string;
    findings: NormalizedAgentOpinion["findings"];
  }>;
  config: KyosoConfig["judge"];
  requestedProvider?: JudgeProvider;
  env: NodeJS.ProcessEnv;
};

export function resolveJudgeProvider(
  provider: JudgeProvider,
  env: NodeJS.ProcessEnv,
): ResolvedJudgeProvider {
  if (provider === "none") return "deterministic_fallback";
  if (provider === "openai") return "openai";
  if (provider === "anthropic") return "anthropic";
  if (hasEnv(env, "OPENAI_API_KEY") || hasEnv(env, "CODEX_API_KEY"))
    return "openai";
  if (hasEnv(env, "ANTHROPIC_API_KEY")) return "anthropic";
  return "deterministic_fallback";
}

export async function runJudge(input: JudgeRunInput): Promise<JudgeRunResult> {
  const fallback = runDeterministicJudge(input.result, input.summaryText);
  if (input.config.mode === "deterministic_only") {
    return {
      provider: "deterministic_fallback",
      status: "deterministic_fallback",
      output: fallback,
    };
  }

  const configuredProvider = input.requestedProvider ?? input.config.provider;
  const provider = resolveJudgeProvider(configuredProvider, input.env);
  if (provider === "deterministic_fallback") {
    return { provider, status: "deterministic_fallback", output: fallback };
  }

  try {
    const output =
      provider === "openai"
        ? await runOpenAiJudge(input, input.config.timeoutMs)
        : await runAnthropicJudge(input, input.config.timeoutMs);
    return { provider, status: "completed", output };
  } catch (error) {
    return {
      provider,
      status: "failed_fallback",
      output: fallback,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}
