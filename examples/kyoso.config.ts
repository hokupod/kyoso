import { defineConfig } from "@kyoso/cli";

export default defineConfig({
  network: {
    defaultMode: "model_only",
    allowUnrestricted: true,
  },
  agents: {
    claude: {
      timeoutMs: 240_000,
      auth: {
        preferApiKey: false,
      },
    },
  },
});
