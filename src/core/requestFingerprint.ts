import { createHash } from "node:crypto";
import type { KyosoConfig } from "../config/schema.js";
import type {
  AgentRole,
  KyosoReviewRequest,
  ReviewBudget,
  ReviewTool,
} from "./types.js";

export const REVIEW_CONTRACT_VERSION = "2026-07-15-v1";

export function createRequestFingerprint(input: {
  tool: ReviewTool;
  request: KyosoReviewRequest;
  config: KyosoConfig;
  roles: Partial<Record<"codex" | "claude", AgentRole>>;
  budget: ReviewBudget;
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
    request,
    reviewers,
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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
