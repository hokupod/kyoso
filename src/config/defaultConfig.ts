import type { KyosoConfigInput } from "./schema.js";

export const defaultConfig: KyosoConfigInput = {
  entrypoints: { mcp: true, cli: true },
  firstClassClient: "codex",
  tools: {
    planReview: true,
    securityReview: true,
    diffReview: true,
  },
  agents: {
    codex: {
      enabled: true,
      type: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      role: "implementation_reviewer",
      timeoutMs: 120_000,
      env: {
        INITIAL_AGENT_MODE: "read-only",
        KYOSO_CHILD_AGENT: "1",
      },
      auth: {
        mode: "passthrough",
        preferExistingLogin: true,
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
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      role: "architecture_security_reviewer",
      timeoutMs: 120_000,
      env: {
        KYOSO_CHILD_AGENT: "1",
      },
      auth: {
        mode: "passthrough",
        preferExistingLogin: true,
        recommendedEnv: ["ANTHROPIC_API_KEY"],
        envWhitelist: [
          "ANTHROPIC_API_KEY",
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
    mode: "deterministic_plus_llm",
    provider: "auto",
    timeoutMs: 60_000,
  },
  audit: {
    enabled: true,
    format: "jsonl",
    directory: ".kyoso/traces",
    includeRawAgentOutput: false,
    includeFileContents: false,
  },
};
