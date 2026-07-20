import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { runReview, type RunReviewOptions } from "../core/runReview.js";
import type { KyosoReviewRequest, ReviewTool } from "../core/types.js";
import { KYOSO_VERSION } from "../core/constants.js";
import { formatMcpResponse } from "./formatMcpResponse.js";
import { createMcpProgressSink } from "./progress.js";
import { kyosoReviewRequestSchema } from "./schemas.js";

export const KYOSO_MCP_INSTRUCTIONS =
  "Kyoso is a multi-agent planning and review gate. Use it only when the user explicitly asks for Kyoso, multi-agent review, plan review, security review, CISA Secure by Design review, or diff review. Kyoso does not apply code changes. It returns structured review results and Markdown summaries.";

export function listKyosoMcpTools(): string[] {
  return ["plan_review", "security_review", "diff_review"];
}

const REVIEW_TOOL_DESCRIPTIONS: Record<ReviewTool, string> = {
  plan_review:
    "Review an implementation plan before coding. Kyoso does not modify files. Sends MCP progress notifications when the client provides a progressToken.",
  security_review:
    "Review a security-sensitive plan, selected files, or diff with CISA Secure by Design gates. Sends MCP progress notifications when the client provides a progressToken.",
  diff_review:
    "Review a provided unified diff after implementation. Kyoso does not apply patches. Sends MCP progress notifications when the client provides a progressToken.",
};

export function createMcpServer(options: RunReviewOptions = {}): McpServer {
  const reviewOptions: RunReviewOptions = { ...options, entrypoint: "mcp" };
  const server = new McpServer(
    { name: "kyoso", version: KYOSO_VERSION },
    { instructions: KYOSO_MCP_INSTRUCTIONS },
  );

  registerReviewTool(server, "plan_review", reviewOptions);
  registerReviewTool(server, "security_review", reviewOptions);
  registerReviewTool(server, "diff_review", reviewOptions);

  return server;
}

function registerReviewTool(
  server: McpServer,
  tool: ReviewTool,
  reviewOptions: RunReviewOptions,
): void {
  server.registerTool(
    tool,
    {
      description: REVIEW_TOOL_DESCRIPTIONS[tool],
      inputSchema: kyosoReviewRequestSchema,
    },
    async (request, ctx) =>
      formatMcpResponse(
        await runReview(tool, request as KyosoReviewRequest, {
          ...reviewOptions,
          signal: ctx.mcpReq.signal,
          onProgress: createMcpProgressSink(ctx.mcpReq),
        }),
      ),
  );
}

export async function startMcpServer(
  options: RunReviewOptions = {},
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
