import type { KyosoConfig } from "../config/schema.js";
import type {
  AgentName,
  CrossModelAnalysis,
  KyosoResult,
  JudgeProvider,
  ModelExecutionIdentity,
  ModelTokenUsage,
  NormalizedAgentOpinion,
  ReviewTool,
} from "../core/types.js";
import { createModelExecutionIdentity } from "../core/modelExecutionIdentity.js";
import { resolveAnthropicJudgeModel, runAnthropicJudge } from "./anthropic.js";
import { runDeterministicJudge } from "./deterministicFallback.js";
import { resolveOpenAiJudgeModel, runOpenAiJudge } from "./openai.js";

export type JudgeOutput = {
  summaryText: string;
  disagreementComments: Array<{ topic: string; judgeComment: string }>;
  analysis?: Omit<CrossModelAnalysis, "provider">;
};

export type ResolvedJudgeProvider =
  Exclude<JudgeProvider, "auto"> | "deterministic_fallback";

export type JudgeCallRoute = {
  provider: ResolvedJudgeProvider;
  llmAvailable: boolean;
};

export type JudgeRunResult = {
  provider: ResolvedJudgeProvider;
  status: "completed" | "deterministic_fallback" | "failed_fallback";
  output: JudgeOutput;
  usage?: ModelTokenUsage;
  executionIdentity?: ModelExecutionIdentity;
  error?: string;
};

export type JudgeProviderOutput = {
  output: JudgeOutput;
  usage?: ModelTokenUsage;
  requestedModel: string;
  reportedModel?: string;
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
  timeoutMs?: number;
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

export function resolveJudgeCallRoute(
  mode: KyosoConfig["judge"]["mode"],
  provider: JudgeProvider,
  env: NodeJS.ProcessEnv,
): JudgeCallRoute {
  const resolvedProvider = resolveJudgeProvider(provider, env);
  const credentialAvailable =
    (resolvedProvider === "openai" &&
      (hasEnv(env, "OPENAI_API_KEY") || hasEnv(env, "CODEX_API_KEY"))) ||
    (resolvedProvider === "anthropic" && hasEnv(env, "ANTHROPIC_API_KEY"));
  return {
    provider: resolvedProvider,
    llmAvailable: mode === "deterministic_plus_llm" && credentialAvailable,
  };
}

export async function runJudge(input: JudgeRunInput): Promise<JudgeRunResult> {
  const fallback = runDeterministicJudge(input.result, input.summaryText);
  const configuredProvider = input.requestedProvider ?? input.config.provider;
  const route = resolveJudgeCallRoute(
    input.config.mode,
    configuredProvider,
    input.env,
  );
  if (!route.llmAvailable) {
    return {
      provider: "deterministic_fallback",
      status: "deterministic_fallback",
      output: fallback,
    };
  }

  const provider = route.provider;
  const requestExecutionIdentity = createModelExecutionIdentity({
    providerRoute: provider === "openai" ? "openai" : "anthropic",
    requestedModel:
      provider === "openai"
        ? resolveOpenAiJudgeModel(input.env)
        : resolveAnthropicJudgeModel(input.env),
  });

  try {
    const output =
      provider === "openai"
        ? await runOpenAiJudge(input, input.timeoutMs ?? input.config.timeoutMs)
        : await runAnthropicJudge(
            input,
            input.timeoutMs ?? input.config.timeoutMs,
          );
    return {
      provider,
      status: "completed",
      output: output.output,
      executionIdentity: createModelExecutionIdentity({
        providerRoute: requestExecutionIdentity.providerRoute,
        requestedModel: output.requestedModel,
        reportedModel: output.reportedModel,
      }),
      ...(output.usage ? { usage: output.usage } : {}),
    };
  } catch (error) {
    return {
      provider,
      status: "failed_fallback",
      output: fallback,
      executionIdentity: requestExecutionIdentity,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}
