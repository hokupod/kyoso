import type { KyosoConfigInput } from "./schema.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_WARN_AGENT_OUTPUT_BYTES,
} from "../core/constants.js";

export const defaultConfig: KyosoConfigInput = {
  entrypoints: { mcp: true, cli: true },
  firstClassClient: "codex",
  tools: {
    planReview: true,
    securityReview: true,
    diffReview: true,
  },
  reviewPolicy: {
    additionalLenses: [],
    multiAgentRequired: false,
  },
  agents: {
    codex: {
      enabled: true,
      type: "acp",
      command: "npx",
      // Pinned on purpose: adapters are fetched at runtime on user machines,
      // so updates must go through a deliberate kyoso release.
      args: ["-y", "@agentclientprotocol/codex-acp@1.1.9"],
      role: "implementation_reviewer",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      allowProjectProvider: [],
      env: {
        INITIAL_AGENT_MODE: "read-only",
        KYOSO_CHILD_AGENT: "1",
      },
      auth: {
        mode: "passthrough",
        preferExistingLogin: true,
        preferApiKey: false,
        recommendedEnv: [],
        envWhitelist: [
          "CODEX_API_KEY",
          "OPENAI_API_KEY",
          "CODEX_HOME",
          "CODEX_ACCESS_TOKEN",
        ],
      },
    },
    claude: {
      enabled: true,
      type: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.64.2"],
      role: "architecture_security_reviewer",
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
      env: {
        KYOSO_CHILD_AGENT: "1",
      },
      auth: {
        mode: "passthrough",
        preferExistingLogin: true,
        preferApiKey: false,
        recommendedEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
        envWhitelist: [
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "ANTHROPIC_MODEL",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CONFIG_DIR",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_FOUNDRY",
        ],
      },
    },
  },
  workspace: {
    mode: "temp_snapshot",
    root: ".",
    readOnly: true,
    maxContextBytes: 500_000,
    maxDiffBytes: 300_000,
    deny: [
      ".env",
      ".env.*",
      ".ssh",
      ".aws",
      ".gcp",
      ".azure",
      "node_modules",
      "dist",
      "build",
      "coverage",
      ".git",
      ".codex",
      ".mcp.json",
      ".claude",
    ],
  },
  secrets: {
    mode: "redact_and_block",
    blockOnDetectedSecret: true,
    allowOverride: true,
  },
  network: {
    defaultMode: "model_only",
    allowUnrestricted: true,
    warnOnUnrestricted: true,
    mediatedWeb: { enabled: false },
  },
  securityReview: {
    cisaSecureByDesign: {
      enabled: true,
      gate: true,
      dimensions: {
        customerSecurityOutcomes: true,
        secureByDefault: true,
        transparencyAndAccountability: true,
        governance: true,
      },
    },
  },
  judge: {
    mode: "deterministic_only",
    provider: "auto",
    timeoutMs: 60_000,
  },
  verification: {
    enabled: false,
    maxFindings: 5,
    timeoutMs: 90_000,
    allowDemotion: false,
  },
  reviewBudget: {
    maxModelCalls: 4,
    maxTotalWallTimeMs: 660_000,
    warnAgentOutputBytes: DEFAULT_WARN_AGENT_OUTPUT_BYTES,
    maxAgentOutputBytes: 1_048_576,
    maxFindingsPerAgent: 10,
    skipOptionalPhasesWhenTokenUsageUnknown: false,
  },
  audit: {
    enabled: true,
    format: "jsonl",
    directory: ".kyoso/traces",
    includeRawAgentOutput: false,
    includeFileContents: false,
  },
};
