import type { KyosoResult } from "../core/types.js";

export function formatMcpResponse(result: KyosoResult) {
  return {
    content: [
      { type: "text" as const, text: result.summaryMarkdown },
      { type: "text" as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}
