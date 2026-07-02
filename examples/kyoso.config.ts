import { defineConfig } from "@kyoso/cli";

export default defineConfig({
  network: {
    defaultMode: "model_only",
    allowUnrestricted: true,
  },
});
