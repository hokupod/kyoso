import { createHash } from "node:crypto";
import type { KyosoConfig } from "../config/schema.js";
import type {
  AgentRole,
  KyosoReviewRequest,
  ResolvedReviewBudget,
  ReviewTool,
} from "./types.js";

export const REVIEW_CONTRACT_VERSION = "2026-07-16-v3";

export function createRequestFingerprint(input: {
  tool: ReviewTool;
  request: KyosoReviewRequest;
  config: KyosoConfig;
  roles: Partial<Record<"codex" | "claude", AgentRole>>;
  budget: ResolvedReviewBudget;
  entrypoint?: "cli" | "mcp" | "core";
}): string {
  const reviewers = (["codex", "claude"] as const)
    .filter((agent) => input.config.agents[agent].enabled)
    .map((agent) => ({
      agent,
      role: input.roles[agent] ?? input.config.agents[agent].role,
      model: input.config.agents[agent].model ?? null,
      provider:
        agent === "codex"
          ? (input.config.agents.codex.provider ?? "default")
          : "default",
    }));
  const request = structuredClone(input.request);
  if (request.options) delete request.options.includeAgentRawOutputs;

  const payload = {
    reviewContractVersion: REVIEW_CONTRACT_VERSION,
    tool: input.tool,
    entrypoint: input.entrypoint ?? "core",
    request,
    reviewers,
    reviewPolicy: input.config.reviewPolicy,
    entrypoints: input.config.entrypoints,
    toolEnabled:
      input.tool === "plan_review"
        ? input.config.tools.planReview
        : input.tool === "security_review"
          ? input.config.tools.securityReview
          : input.config.tools.diffReview,
    cisaSecureByDesign: input.config.securityReview.cisaSecureByDesign,
    verification: input.config.verification,
    judge: {
      ...input.config.judge,
      requestedProvider: input.request.options?.judgeProvider ?? null,
    },
    executionBudget: input.budget,
  };
  return `sha256:${createHash("sha256")
    .update(canonicalJson(payload), "utf8")
    .digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
