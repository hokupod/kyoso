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
