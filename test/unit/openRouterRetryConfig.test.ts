import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loadConfig.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  CODEX_OPENROUTER_MODEL_REQUIRED_ISSUE,
  CODEX_OPENROUTER_POLICY_REQUIRES_PROVIDER_ISSUE,
  kyosoConfigSchema,
} from "../../src/config/schema.js";
import { buildChildLaunchContext } from "../../src/utils/env.js";

describe("OpenRouter retry configuration", () => {
  test("accepts valid retry policy values, including zero retries", () => {
    const configured = kyosoConfigSchema.safeParse(
      retryConfig({
        streamIdleTimeoutMs: 90_000,
        streamMaxRetries: 3,
        requestMaxRetries: 2,
      }),
    );
    const disabledRetries = kyosoConfigSchema.safeParse(
      retryConfig({ streamMaxRetries: 0, requestMaxRetries: 0 }),
    );

    expect(configured.success).toBe(true);
    if (configured.success) {
      expect(configured.data.agents.codex.openRouter).toEqual({
        streamIdleTimeoutMs: 90_000,
        streamMaxRetries: 3,
        requestMaxRetries: 2,
      });
    }
    expect(disabledRetries.success).toBe(true);
    if (disabledRetries.success) {
      expect(disabledRetries.data.agents.codex.openRouter).toEqual({
        streamMaxRetries: 0,
        requestMaxRetries: 0,
      });
    }
  });

  test("rejects invalid retry policy values", () => {
    for (const openRouter of [
      { streamMaxRetries: 101 },
      { streamMaxRetries: -1 },
      { requestMaxRetries: -1 },
      { streamIdleTimeoutMs: 999 },
      { streamIdleTimeoutMs: 1_000.5 },
    ]) {
      expect(kyosoConfigSchema.safeParse(retryConfig(openRouter)).success).toBe(
        false,
      );
    }
  });

  test("requires the OpenRouter provider only for a configured retry policy", () => {
    const policyWithoutProvider = kyosoConfigSchema.safeParse(
      retryConfig({ streamMaxRetries: 3 }, { provider: "default" }),
    );
    const missingModel = kyosoConfigSchema.safeParse(
      retryConfig({ streamMaxRetries: 3 }, { model: undefined }),
    );
    const emptyPolicy = kyosoConfigSchema.safeParse(
      retryConfig({}, { provider: undefined }),
    );

    expect(policyWithoutProvider.success).toBe(false);
    if (!policyWithoutProvider.success) {
      expect(policyWithoutProvider.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["agents", "codex", "openRouter"],
          params: {
            kyosoIssue: CODEX_OPENROUTER_POLICY_REQUIRES_PROVIDER_ISSUE,
          },
        }),
      );
    }
    expect(missingModel.success).toBe(false);
    if (!missingModel.success) {
      expect(missingModel.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["agents", "codex", "model"],
          params: { kyosoIssue: CODEX_OPENROUTER_MODEL_REQUIRED_ISSUE },
        }),
      );
    }
    expect(emptyPolicy.success).toBe(true);
  });

  test("warns about a case-sensitive retry policy typo in global TOML", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-openrouter-retry-"));
    const configHome = join(cwd, "xdg");
    const configPath = join(configHome, "kyoso", "config.toml");
    await mkdir(join(configHome, "kyoso"), { recursive: true });
    await writeFile(
      configPath,
      `[agents.codex]
provider = "openrouter"
model = "openai/o4-mini"

[agents.codex.openRouter]
streamIdleTimeoutMS = 90000
`,
      "utf8",
    );

    const loaded = await loadConfig({
      cwd,
      env: { XDG_CONFIG_HOME: configHome },
      allowUnknownConfig: true,
    });

    expect(loaded.warnings.join("\n")).toContain(
      '"agents.codex.openRouter.streamIdleTimeoutMS"',
    );
  });

  test("maps configured retry policy fields to the OpenRouter preset", () => {
    const launch = buildChildLaunchContext(
      { PATH: "/usr/bin", OPENROUTER_API_KEY: "test-key" },
      [],
      {},
      {
        agent: "codex",
        provider: "openrouter",
        model: "openai/o4-mini",
        openRouter: {
          streamIdleTimeoutMs: 90_000,
          streamMaxRetries: 0,
          requestMaxRetries: 2,
        },
      },
    );
    const preset = readOpenRouterPreset(launch.env);

    expect(preset).toMatchObject({
      stream_idle_timeout_ms: 90_000,
      stream_max_retries: 0,
      request_max_retries: 2,
    });
  });

  test("omits unset retry policy fields and the default route preset", () => {
    const openRouterLaunch = buildChildLaunchContext(
      { PATH: "/usr/bin", OPENROUTER_API_KEY: "test-key" },
      [],
      {},
      {
        agent: "codex",
        provider: "openrouter",
        model: "openai/o4-mini",
        openRouter: { streamMaxRetries: 0 },
      },
    );
    const defaultLaunch = buildChildLaunchContext(
      { PATH: "/usr/bin" },
      [],
      {},
      { agent: "codex", model: "gpt-5.4" },
    );
    const preset = readOpenRouterPreset(openRouterLaunch.env);
    const defaultConfig = JSON.parse(
      defaultLaunch.env.CODEX_CONFIG ?? "{}",
    ) as {
      model_providers?: unknown;
    };

    expect("stream_idle_timeout_ms" in preset).toBe(false);
    expect(preset.stream_max_retries).toBe(0);
    expect("request_max_retries" in preset).toBe(false);
    expect(defaultConfig.model_providers).toBeUndefined();
  });

  test("preserves credential and foreign-provider isolation for retry configuration", () => {
    let discardedProviderCount = 0;
    const launch = buildChildLaunchContext(
      { PATH: "/usr/bin", OPENROUTER_API_KEY: "test-key" },
      [],
      {
        OPENAI_API_KEY: "openai-key",
        CODEX_API_KEY: "codex-key",
        CODEX_ACCESS_TOKEN: "access-token",
        CODEX_CONFIG: JSON.stringify({
          model_providers: { foreign: { name: "Foreign" } },
        }),
      },
      {
        agent: "codex",
        provider: "openrouter",
        model: "openai/o4-mini",
        openRouter: { requestMaxRetries: 2 },
        onOpenRouterProvidersDiscarded: (count) => {
          discardedProviderCount = count;
        },
      },
    );
    const config = JSON.parse(launch.env.CODEX_CONFIG ?? "{}") as {
      model_providers?: Record<string, unknown>;
    };

    expect(launch.env.OPENAI_API_KEY).toBeUndefined();
    expect(launch.env.CODEX_API_KEY).toBeUndefined();
    expect(launch.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(config.model_providers).toEqual(
      expect.objectContaining({ "kyoso-openrouter": expect.any(Object) }),
    );
    expect(config.model_providers?.foreign).toBeUndefined();
    expect(discardedProviderCount).toBe(1);
  });
});

function retryConfig(
  openRouter: unknown,
  options: { provider?: "openrouter" | "default"; model?: string } = {},
): unknown {
  const codex: Record<string, unknown> = {
    ...(defaultConfig.agents?.codex ?? {}),
    openRouter,
  };
  if (Object.hasOwn(options, "provider")) {
    if (options.provider !== undefined) codex.provider = options.provider;
  } else {
    codex.provider = "openrouter";
  }
  if (Object.hasOwn(options, "model")) {
    if (options.model !== undefined) codex.model = options.model;
  } else {
    codex.model = "openai/o4-mini";
  }
  return {
    ...defaultConfig,
    agents: {
      ...defaultConfig.agents,
      codex,
    },
  };
}

function readOpenRouterPreset(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const config = JSON.parse(env.CODEX_CONFIG ?? "{}") as {
    model_providers?: Record<string, Record<string, unknown>>;
  };
  const preset = config.model_providers?.["kyoso-openrouter"];
  if (!preset) throw new Error("OpenRouter preset was not configured.");
  return preset;
}
