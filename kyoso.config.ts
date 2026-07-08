import { defineConfig } from "@kyo-so/cli";

// Dogfooding config for this repository: enable the adversarial
// verification round so verdict data accumulates in .kyoso/traces/.
// Phase 1 is annotate-only; allowDemotion stays false.
export default defineConfig({
  verification: {
    enabled: true,
  },
});
