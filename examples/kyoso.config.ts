import { defineConfig } from "@kyo-so/cli";

export default defineConfig({
  network: {
    defaultMode: "model_only",
    allowUnrestricted: true,
  },
  agents: {
    codex: {
      // Omit model to use the user's Codex default from ~/.codex/config.toml.
      // model: "gpt-5.5",
    },
    claude: {
      // Omit model to use the Claude adapter default.
      // model: "claude-sonnet-5",
      timeoutMs: 240_000,
      auth: {
        preferApiKey: false,
      },
    },
  },
});
