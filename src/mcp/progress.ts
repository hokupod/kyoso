import { formatPlainProgressMessage } from "../cli/progress.js";
import type {
  ReviewProgressEvent,
  ReviewProgressSink,
} from "../core/progress.js";

type McpProgressNotification = {
  method: "notifications/progress";
  params: {
    progressToken: string | number;
    progress: number;
    message: string;
  };
};

export type McpRequestContextLike = {
  _meta?: { progressToken?: string | number };
  notify: (notification: McpProgressNotification) => Promise<void>;
};

export function createMcpProgressSink(
  mcpReq: McpRequestContextLike,
): ReviewProgressSink | undefined {
  const progressToken = mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;

  let sequence = 0;
  return async (event) => {
    await mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: ++sequence,
        message: formatMcpProgressMessage(event),
      },
    });
  };
}

export function formatMcpProgressMessage(event: ReviewProgressEvent): string {
  return formatPlainProgressMessage(event);
}
