import { JUDGE_MAX_OUTPUT_TOKENS } from "../core/constants.js";
import { normalizeModelTokenUsage } from "../core/tokenUsage.js";
import type { JudgeProviderOutput, JudgeRunInput } from "./provider.js";
import { buildJudgePrompt, parseJudgeOutput } from "./prompt.js";

export const DEFAULT_ANTHROPIC_JUDGE_MODEL = "claude-haiku-4-5";

export function resolveAnthropicJudgeModel(env: NodeJS.ProcessEnv): string {
  return env.KYOSO_ANTHROPIC_JUDGE_MODEL ?? DEFAULT_ANTHROPIC_JUDGE_MODEL;
}

export async function runAnthropicJudge(
  input: JudgeRunInput,
  timeoutMs: number,
): Promise<JudgeProviderOutput> {
  const apiKey = input.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const requestedModel = resolveAnthropicJudgeModel(input.env);

  const response = await fetchWithTimeout(
    `${input.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"}/v1/messages`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: requestedModel,
        max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: buildJudgePrompt(
              input.tool,
              input.result,
              input.summaryText,
              input.agentFindings,
            ),
          },
        ],
      }),
    },
    timeoutMs,
  );

  if (!response.ok)
    throw new Error(`Anthropic judge failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    model?: unknown;
    content?: Array<{ type?: string; text?: string }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  const content = payload.content?.find(
    (item) => item.type === "text" && item.text,
  )?.text;
  if (!content)
    throw new Error("Anthropic judge response did not include text content.");
  const usage = normalizeUsage(payload.usage);
  const reportedModel =
    typeof payload.model === "string" ? payload.model : undefined;
  return {
    output: parseJudgeOutput(content, input.summaryText),
    requestedModel,
    ...(reportedModel ? { reportedModel } : {}),
    ...(usage ? { usage } : {}),
  };
}

function normalizeUsage(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined,
): JudgeProviderOutput["usage"] {
  if (!usage) return undefined;
  return normalizeModelTokenUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedReadTokens: usage.cache_read_input_tokens,
    cachedWriteTokens: usage.cache_creation_input_tokens,
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
