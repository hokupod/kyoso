import { describe, expect, test } from "bun:test";
import { applyConfigOverrides } from "../../src/config/configOverrides.js";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import {
  collectProjectScopeViolations,
  isAllowedConfigOverridePath,
  kyosoConfigOverridePaths,
} from "../../src/config/projectScope.js";
import { kyosoConfigSchema } from "../../src/config/schema.js";

describe("config overrides", () => {
  test("applies repeatable string, boolean, and number overrides last", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);
    const overridden = applyConfigOverrides(config, [
      "agents.claude.effort=medium",
      "agents.claude.effort=high=extended",
      "agents.claude.model=123",
      "agents.codex.effort=false",
      "agents.codex.enabled=false",
      "agents.claude.timeoutMs=300000",
      "verification.maxFindings=0",
      "judge.provider=none",
    ]);

    expect(overridden.agents.claude.effort).toBe("high=extended");
    expect(overridden.agents.claude.model).toBe("123");
    expect(overridden.agents.codex.effort).toBe("false");
    expect(overridden.agents.codex.enabled).toBe(false);
    expect(overridden.agents.claude.timeoutMs).toBe(300_000);
    expect(overridden.verification.maxFindings).toBe(0);
    expect(overridden.judge.provider).toBe("none");
    expect(config.agents.claude.effort).toBeUndefined();
  });

  test("parses every seconds override as a number", () => {
    const overridden = applyConfigOverrides(
      kyosoConfigSchema.parse(defaultConfig),
      [
        "agents.codex.provider=openrouter",
        "agents.codex.model=openai/o4-mini",
        "agents.codex.timeoutS=1.5",
        "agents.claude.timeoutS=2",
        "agents.codex.openRouter.streamIdleTimeoutS=3",
        "verification.timeoutS=4",
        "judge.timeoutS=5",
      ],
    );

    expect(overridden.agents.codex.timeoutMs).toBe(1_500);
    expect(overridden.agents.claude.timeoutMs).toBe(2_000);
    expect(overridden.agents.codex.openRouter.streamIdleTimeoutMs).toBe(3_000);
    expect(overridden.verification.timeoutMs).toBe(4_000);
    expect(overridden.judge.timeoutMs).toBe(5_000);
  });

  test("prefers seconds regardless of assignment order", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);
    for (const assignments of [
      ["agents.claude.timeoutMs=1000", "agents.claude.timeoutS=2"],
      ["agents.claude.timeoutS=2", "agents.claude.timeoutMs=1000"],
    ]) {
      expect(
        applyConfigOverrides(config, assignments).agents.claude.timeoutMs,
      ).toBe(2_000);
    }
  });

  test("keeps last-write-wins for repeated seconds assignments", () => {
    const overridden = applyConfigOverrides(
      kyosoConfigSchema.parse(defaultConfig),
      ["agents.claude.timeoutS=1", "agents.claude.timeoutS=2"],
    );

    expect(overridden.agents.claude.timeoutMs).toBe(2_000);
  });

  test("attributes invalid seconds to the original assignment", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    expect(() =>
      applyConfigOverrides(config, [
        "agents.claude.timeoutS=0.0001",
        "agents.codex.enabled=false",
      ]),
    ).toThrow(
      'Invalid --set value "agents.claude.timeoutS=0.0001": agents.claude.timeoutS',
    );
    expect(() =>
      applyConfigOverrides(config, [
        "agents.claude.timeoutMs=-1",
        "agents.claude.timeoutS=2",
      ]),
    ).toThrow('Invalid --set value "agents.claude.timeoutMs=-1"');
  });

  test("does not attribute inherited conversion errors to unrelated assignments", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);
    const invalidConfig = {
      ...config,
      agents: {
        ...config.agents,
        claude: {
          ...config.agents.claude,
          timeoutMs: -1,
        },
      },
    };

    expect(() =>
      applyConfigOverrides(invalidConfig, [
        "agents.claude.timeoutS=2",
        "agents.codex.enabled=false",
      ]),
    ).toThrow("Invalid config time value: agents.claude.timeoutMs");
  });

  test("rejects assignments without key=value", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    expect(() =>
      applyConfigOverrides(config, ["agents.claude.effort"]),
    ).toThrow(
      'Invalid --set value "agents.claude.effort". Expected key=value.',
    );
  });

  test("rejects keys outside the shared project allowlist", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    expect(() =>
      applyConfigOverrides(config, ["agents.claude.command=bun"]),
    ).toThrow('Unknown --set key "agents.claude.command".');
    expect(() =>
      applyConfigOverrides(config, ["agents.codex.allowProjectProvider=true"]),
    ).toThrow('Unknown --set key "agents.codex.allowProjectProvider".');
    expect(() =>
      applyConfigOverrides(config, ["reviewBudget.maxTotalWallTimeS=10"]),
    ).toThrow('Unknown --set key "reviewBudget.maxTotalWallTimeS".');
    expect(isAllowedConfigOverridePath(["workspace", "root"])).toBe(false);
  });

  test("revalidates the overridden config schema", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    expect(() =>
      applyConfigOverrides(config, ["agents.claude.timeoutMs=-1"]),
    ).toThrow('Invalid --set value "agents.claude.timeoutMs=-1"');
    expect(() =>
      applyConfigOverrides(config, ["verification.enabled=yes"]),
    ).toThrow('Invalid --set value "verification.enabled=yes"');
  });

  test("uses the base config type for repeated overrides of one key", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);
    const overridden = applyConfigOverrides(config, [
      "verification.enabled=1",
      "verification.enabled=true",
      "agents.claude.timeoutMs=invalid",
      "agents.claude.timeoutMs=+6000",
    ]);

    expect(overridden.verification.enabled).toBe(true);
    expect(overridden.agents.claude.timeoutMs).toBe(6_000);
  });

  test("accepts OpenRouter provider and model overrides together", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    const overridden = applyConfigOverrides(config, [
      "agents.codex.provider=openrouter",
      "agents.codex.model=openai/o4-mini",
      "agents.codex.openRouter.streamMaxRetries=3",
    ]);

    expect(overridden.agents.codex.provider).toBe("openrouter");
    expect(overridden.agents.codex.model).toBe("openai/o4-mini");

    const reset = applyConfigOverrides(overridden, [
      "agents.codex.provider=default",
    ]);

    expect(reset.agents.codex.provider).toBe("default");
    expect(reset.agents.codex.model).toBeUndefined();
    expect(reset.agents.codex.openRouter).toEqual({});

    const resetWithModel = applyConfigOverrides(overridden, [
      "agents.codex.provider=default",
      "agents.codex.model=gpt-5.4",
    ]);

    expect(resetWithModel.agents.codex.provider).toBe("default");
    expect(resetWithModel.agents.codex.model).toBe("gpt-5.4");
    expect(resetWithModel.agents.codex.openRouter).toEqual({});

    expect(() =>
      applyConfigOverrides(overridden, [
        "agents.codex.provider=default",
        "agents.codex.openRouter.streamMaxRetries=0",
      ]),
    ).toThrow(
      'agents.codex.openRouter: agents.codex.openRouter.* requires provider = "openrouter".',
    );
  });

  test("parses unset OpenRouter retry overrides as explicitly allowed numbers", () => {
    const openRouterConfig = applyConfigOverrides(
      kyosoConfigSchema.parse(defaultConfig),
      ["agents.codex.provider=openrouter", "agents.codex.model=openai/o4-mini"],
    );

    const overridden = applyConfigOverrides(openRouterConfig, [
      "agents.codex.openRouter.streamIdleTimeoutMs=90000",
      "agents.codex.openRouter.streamMaxRetries=0",
    ]);

    expect(overridden.agents.codex.openRouter).toEqual({
      streamIdleTimeoutMs: 90_000,
      streamMaxRetries: 0,
    });
    expect(() =>
      applyConfigOverrides(openRouterConfig, [
        "agents.codex.openRouter.streamMaxRetries=abc",
      ]),
    ).toThrow(
      'Invalid --set value "agents.codex.openRouter.streamMaxRetries=abc"',
    );
    expect(() =>
      applyConfigOverrides(kyosoConfigSchema.parse(defaultConfig), [
        "agents.codex.openRouter.streamMaxRetries=3",
      ]),
    ).toThrow(
      'Invalid --set value "agents.codex.openRouter.streamMaxRetries=3"',
    );
  });

  test("does not mutate the loaded OpenRouter model when resetting the provider", () => {
    const loadedConfig = applyConfigOverrides(
      kyosoConfigSchema.parse(defaultConfig),
      ["agents.codex.provider=openrouter", "agents.codex.model=openai/o4-mini"],
    );

    const reset = applyConfigOverrides(loadedConfig, [
      "agents.codex.provider=default",
    ]);

    expect(reset.agents.codex.provider).toBe("default");
    expect(reset.agents.codex.model).toBeUndefined();
    expect(loadedConfig.agents.codex.provider).toBe("openrouter");
    expect(loadedConfig.agents.codex.model).toBe("openai/o4-mini");
  });

  test("rejects incomplete or unsupported OpenRouter provider overrides", () => {
    const config = kyosoConfigSchema.parse(defaultConfig);

    expect(() =>
      applyConfigOverrides(config, ["agents.codex.provider=openrouter"]),
    ).toThrow(
      'Invalid --set value "agents.codex.provider=openrouter": selecting agents.codex.provider=openrouter requires agents.codex.model in the same --set invocation.',
    );
    expect(() =>
      applyConfigOverrides(config, [
        "agents.codex.provider=openrouter",
        "agents.codex.model=",
      ]),
    ).toThrow(
      'Invalid --set value "agents.codex.model=": agents.codex.model: model must be a non-empty string when provider is "openrouter".',
    );
    expect(() =>
      applyConfigOverrides(config, ["agents.codex.provider=openai"]),
    ).toThrow('Invalid --set value "agents.codex.provider=openai"');
  });

  test("keeps every override key valid in project scope", () => {
    for (const key of kyosoConfigOverridePaths) {
      const path = key.split(".");
      expect(isAllowedConfigOverridePath(path)).toBe(true);
      expect(collectProjectScopeViolations(nestedValue(path, true))).toEqual(
        [],
      );
    }
  });
});

function nestedValue(path: string[], value: unknown): unknown {
  return path.reduceRight<Record<string, unknown> | unknown>(
    (child, key) => ({ [key]: child }),
    value,
  );
}
