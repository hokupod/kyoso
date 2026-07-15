import { JUDGE_MAX_OUTPUT_TOKENS } from "../core/constants.js";
import { normalizeModelTokenUsage } from "../core/tokenUsage.js";
import type { JudgeProviderOutput, JudgeRunInput } from "./provider.js";
import { buildJudgePrompt, parseJudgeOutput } from "./prompt.js";

export async function runOpenAiJudge(
  input: JudgeRunInput,
  timeoutMs: number,
): Promise<JudgeProviderOutput> {
  const apiKey = input.env.OPENAI_API_KEY ?? input.env.CODEX_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const response = await fetchWithTimeout(
    `${input.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: input.env.KYOSO_OPENAI_JUDGE_MODEL ?? "gpt-5.4-mini",
        response_format: { type: "json_object" },
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
        max_completion_tokens: JUDGE_MAX_OUTPUT_TOKENS,
        temperature: 0,
      }),
    },
    timeoutMs,
  );

  if (!response.ok)
    throw new Error(`OpenAI judge failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      total_tokens?: number;
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content)
    throw new Error("OpenAI judge response did not include content.");
  const usage = normalizeUsage(payload.usage);
  return {
    output: parseJudgeOutput(content, input.summaryText),
    ...(usage ? { usage } : {}),
  };
}

function normalizeUsage(
  usage:
    | {
        total_tokens?: number;
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined,
): JudgeProviderOutput["usage"] {
  if (!usage) return undefined;
  return normalizeModelTokenUsage({
    totalTokens: usage.total_tokens,
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedReadTokens: usage.prompt_tokens_details?.cached_tokens,
    thoughtTokens: usage.completion_tokens_details?.reasoning_tokens,
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
