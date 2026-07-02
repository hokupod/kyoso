import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { runReview, type RunReviewOptions } from "../core/runReview.js";
import type { KyosoReviewRequest } from "../core/types.js";
import { KYOSO_VERSION } from "../core/constants.js";
import { formatMcpResponse } from "./formatMcpResponse.js";
import { kyosoReviewRequestSchema } from "./schemas.js";

export const KYOSO_MCP_INSTRUCTIONS =
  "Kyoso is a multi-agent planning and review gate. Use it only when the user explicitly asks for Kyoso, multi-agent review, plan review, security review, CISA Secure by Design review, or diff review. Kyoso does not apply code changes. It returns structured review results and Markdown summaries.";

export function listKyosoMcpTools(): string[] {
  return ["plan_review", "security_review", "diff_review"];
}

export function createMcpServer(options: RunReviewOptions = {}): McpServer {
  const server = new McpServer(
    { name: "kyoso", version: KYOSO_VERSION },
    { instructions: KYOSO_MCP_INSTRUCTIONS },
  );

  server.registerTool(
    "plan_review",
    {
      description:
        "Review an implementation plan before coding. Kyoso does not modify files.",
      inputSchema: kyosoReviewRequestSchema,
    },
    async (request) =>
      formatMcpResponse(
        await runReview("plan_review", request as KyosoReviewRequest, options),
      ),
  );

  server.registerTool(
    "security_review",
    {
      description:
        "Review a security-sensitive plan, selected files, or diff with CISA Secure by Design gates.",
      inputSchema: kyosoReviewRequestSchema,
    },
    async (request) =>
      formatMcpResponse(
        await runReview(
          "security_review",
          request as KyosoReviewRequest,
          options,
        ),
      ),
  );

  server.registerTool(
    "diff_review",
    {
      description:
        "Review a provided unified diff after implementation. Kyoso does not apply patches.",
      inputSchema: kyosoReviewRequestSchema,
    },
    async (request) =>
      formatMcpResponse(
        await runReview("diff_review", request as KyosoReviewRequest, options),
      ),
  );

  return server;
}

export async function startMcpServer(
  options: RunReviewOptions = {},
): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
