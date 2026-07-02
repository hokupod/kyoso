import type { JudgeRunInput, JudgeOutput } from "./provider.js";
import { buildJudgePrompt, parseJudgeOutput } from "./prompt.js";

export async function runOpenAiJudge(
  input: JudgeRunInput,
  timeoutMs: number,
): Promise<JudgeOutput> {
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
        model: input.env.KYOSO_OPENAI_JUDGE_MODEL ?? "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: buildJudgePrompt(
              input.tool,
              input.result,
              input.summaryText,
            ),
          },
        ],
        temperature: 0,
      }),
    },
    timeoutMs,
  );

  if (!response.ok)
    throw new Error(`OpenAI judge failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content)
    throw new Error("OpenAI judge response did not include content.");
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
