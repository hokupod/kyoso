import { z } from "zod";

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown>
    ? PartialDeep<T[K]>
    : T[K];
};

const agentSchema = z.object({
  enabled: z.boolean().default(true),
  type: z.literal("acp").default("acp"),
  command: z.string(),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  role: z.enum([
    "implementation_reviewer",
    "architecture_security_reviewer",
    "combined_reviewer",
  ]),
  timeoutMs: z.number().int().positive().default(120_000),
  env: z.record(z.string(), z.string()).default({}),
  auth: z.object({
    mode: z.literal("passthrough").default("passthrough"),
    preferExistingLogin: z.boolean().default(true),
    preferApiKey: z.boolean().default(false),
    recommendedEnv: z.array(z.string()),
    envWhitelist: z.array(z.string()),
  }),
});

export const kyosoConfigSchema = z.object({
  entrypoints: z.object({
    mcp: z.boolean(),
    cli: z.boolean(),
  }),
  firstClassClient: z.string(),
  tools: z.object({
    planReview: z.boolean(),
    securityReview: z.boolean(),
    diffReview: z.boolean(),
  }),
  agents: z.object({
    codex: agentSchema,
    claude: agentSchema,
  }),
  workspace: z.object({
    mode: z.literal("temp_snapshot"),
    root: z.string(),
    readOnly: z.boolean(),
    maxContextBytes: z.number().int().positive(),
    maxDiffBytes: z.number().int().positive(),
    deny: z.array(z.string()),
  }),
  secrets: z.object({
    mode: z.literal("redact_and_block"),
    blockOnDetectedSecret: z.boolean(),
    allowOverride: z.boolean(),
  }),
  network: z.object({
    defaultMode: z.enum(["model_only", "unrestricted"]),
    allowUnrestricted: z.boolean(),
    warnOnUnrestricted: z.boolean(),
    mediatedWeb: z.object({ enabled: z.boolean() }),
  }),
  securityReview: z.object({
    cisaSecureByDesign: z.object({
      enabled: z.boolean(),
      gate: z.boolean(),
      dimensions: z.object({
        customerSecurityOutcomes: z.boolean(),
        secureByDefault: z.boolean(),
        transparencyAndAccountability: z.boolean(),
        governance: z.boolean(),
      }),
    }),
  }),
  judge: z.object({
    mode: z.enum(["deterministic_plus_llm", "deterministic_only"]),
    provider: z.enum(["auto", "openai", "anthropic", "none"]),
    timeoutMs: z.number().int().positive(),
  }),
  verification: z.object({
    enabled: z.boolean().default(false),
    maxFindings: z.number().int().nonnegative().default(5),
    timeoutMs: z.number().int().positive().default(90_000),
    allowDemotion: z.boolean().default(false),
  }),
  audit: z.object({
    enabled: z.boolean(),
    format: z.literal("jsonl"),
    directory: z.string(),
    includeRawAgentOutput: z.boolean(),
    includeFileContents: z.boolean(),
  }),
});

function agentConfigLeafPaths(agent: "codex" | "claude"): string[] {
  return [
    `agents.${agent}.enabled`,
    `agents.${agent}.type`,
    `agents.${agent}.command`,
    `agents.${agent}.args`,
    `agents.${agent}.model`,
    `agents.${agent}.role`,
    `agents.${agent}.timeoutMs`,
    `agents.${agent}.env`,
    `agents.${agent}.auth.mode`,
    `agents.${agent}.auth.preferExistingLogin`,
    `agents.${agent}.auth.preferApiKey`,
    `agents.${agent}.auth.recommendedEnv`,
    `agents.${agent}.auth.envWhitelist`,
  ];
}

export const kyosoConfigKnownLeafPaths = [
  "entrypoints.mcp",
  "entrypoints.cli",
  "firstClassClient",
  "tools.planReview",
  "tools.securityReview",
  "tools.diffReview",
  ...agentConfigLeafPaths("codex"),
  ...agentConfigLeafPaths("claude"),
  "workspace.mode",
  "workspace.root",
  "workspace.readOnly",
  "workspace.maxContextBytes",
  "workspace.maxDiffBytes",
  "workspace.deny",
  "secrets.mode",
  "secrets.blockOnDetectedSecret",
  "secrets.allowOverride",
  "network.defaultMode",
  "network.allowUnrestricted",
  "network.warnOnUnrestricted",
  "network.mediatedWeb.enabled",
  "securityReview.cisaSecureByDesign.enabled",
  "securityReview.cisaSecureByDesign.gate",
  "securityReview.cisaSecureByDesign.dimensions.customerSecurityOutcomes",
  "securityReview.cisaSecureByDesign.dimensions.secureByDefault",
  "securityReview.cisaSecureByDesign.dimensions.transparencyAndAccountability",
  "securityReview.cisaSecureByDesign.dimensions.governance",
  "judge.mode",
  "judge.provider",
  "judge.timeoutMs",
  "verification.enabled",
  "verification.maxFindings",
  "verification.timeoutMs",
  "verification.allowDemotion",
  "audit.enabled",
  "audit.format",
  "audit.directory",
  "audit.includeRawAgentOutput",
  "audit.includeFileContents",
];

export const kyosoConfigRecordPrefixes = [
  "agents.codex.env",
  "agents.claude.env",
];

export const kyosoConfigSecuritySensitivePrefixes = [
  "agents.codex",
  "agents.claude",
  "audit",
  "judge",
  "network",
  "secrets",
  "securityReview",
  "verification",
  "workspace",
];

export type KyosoConfig = z.infer<typeof kyosoConfigSchema>;
export type KyosoConfigInput = PartialDeep<KyosoConfig>;
