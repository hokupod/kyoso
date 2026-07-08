import type { JudgeRunInput, JudgeOutput } from "./provider.js";
import { buildJudgePrompt, parseJudgeOutput } from "./prompt.js";

export async function runAnthropicJudge(
  input: JudgeRunInput,
  timeoutMs: number,
): Promise<JudgeOutput> {
  const apiKey = input.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");

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
        model: input.env.KYOSO_ANTHROPIC_JUDGE_MODEL ?? "claude-haiku-4-5",
        max_tokens: 4096,
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
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = payload.content?.find(
    (item) => item.type === "text" && item.text,
  )?.text;
  if (!content)
    throw new Error("Anthropic judge response did not include text content.");
  return parseJudgeOutput(content, input.summaryText);
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
