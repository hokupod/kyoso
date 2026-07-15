import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { defaultConfig } from "../../src/config/defaultConfig.js";
import { kyosoConfigSchema } from "../../src/config/schema.js";
import {
  OPENROUTER_ACP_SMOKE_MODEL_ENV,
  OPENROUTER_ACP_SMOKE_OPT_IN_ENV,
  OPENROUTER_ACP_SMOKE_OPT_IN_VALUE,
  OPENROUTER_ACP_SMOKE_SUCCESS_MARKER,
  assertOpenRouterCodexAcpSmokeArguments,
  createOpenRouterCodexAcpSmokeConfig,
  runOpenRouterCodexAcpSmoke,
  validateOpenRouterCodexAcpSmoke,
} from "../../src/cli/openRouterAcpSmoke.js";

const testKey = "test-openrouter-key-not-for-use";
const smokeEnv: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/real-home",
  CODEX_HOME: "/real-codex-home",
  OPENROUTER_API_KEY: testKey,
  [OPENROUTER_ACP_SMOKE_OPT_IN_ENV]: OPENROUTER_ACP_SMOKE_OPT_IN_VALUE,
  [OPENROUTER_ACP_SMOKE_MODEL_ENV]: "openai/gpt-4.1-mini",
};

describe("OpenRouter Codex ACP smoke", () => {
  test("requires an explicit release opt-in before it can invoke ACP", async () => {
    let calls = 0;

    await expect(
      runOpenRouterCodexAcpSmoke({
        env: omit(smokeEnv, OPENROUTER_ACP_SMOKE_OPT_IN_ENV),
        runAgent: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("is disabled");

    expect(calls).toBe(0);
  });

  test("fails before ACP launch when a required environment value is unavailable", () => {
    expect(() =>
      validateOpenRouterCodexAcpSmoke(omit(smokeEnv, "PATH")),
    ).toThrow("PATH");
    expect(() =>
      validateOpenRouterCodexAcpSmoke(omit(smokeEnv, "OPENROUTER_API_KEY")),
    ).toThrow("OPENROUTER_API_KEY");
    expect(() =>
      validateOpenRouterCodexAcpSmoke(
        omit(smokeEnv, OPENROUTER_ACP_SMOKE_MODEL_ENV),
      ),
    ).toThrow(OPENROUTER_ACP_SMOKE_MODEL_ENV);
    expect(() =>
      validateOpenRouterCodexAcpSmoke({
        ...smokeEnv,
        OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
      }),
    ).toThrow("OPENROUTER_API_KEY");
  });

  test("uses the normal pinned Codex ACP adapter without storing the key in config", () => {
    const normalConfig = kyosoConfigSchema.parse(defaultConfig);
    const config = createOpenRouterCodexAcpSmokeConfig(
      smokeEnv[OPENROUTER_ACP_SMOKE_MODEL_ENV] ?? "",
    );

    expect(config.agents.codex.provider).toBe("openrouter");
    expect(config.agents.codex.model).toBe("openai/gpt-4.1-mini");
    expect(config.agents.codex.command).toBe(normalConfig.agents.codex.command);
    expect(config.agents.codex.args).toEqual(normalConfig.agents.codex.args);
    expect(config.agents.codex.args).toContain(
      "@agentclientprotocol/codex-acp@1.1.2",
    );
    expect(JSON.stringify(config)).not.toContain(testKey);
  });

  test("runs a single Codex ACP request and emits only a fixed success result", async () => {
    const normalConfig = kyosoConfigSchema.parse(defaultConfig);
    let workspaceDir = "";
    let childEnv: NodeJS.ProcessEnv | undefined;
    const output = await runOpenRouterCodexAcpSmoke({
      env: smokeEnv,
      runAgent: async (input, config, environment) => {
        expect(input.agent).toBe("codex");
        workspaceDir = input.workspaceDir;
        childEnv = environment;
        expect(input.workspaceDir).toContain("kyoso-openrouter-acp-smoke-");
        expect(await readdir(input.workspaceDir)).toEqual([]);
        expect(childEnv.HOME).not.toBe(smokeEnv.HOME);
        expect(childEnv.CODEX_HOME).not.toBe(smokeEnv.CODEX_HOME);
        expect(await readdir(childEnv.HOME ?? "")).toEqual([]);
        expect(await readdir(childEnv.CODEX_HOME ?? "")).toEqual([]);
        expect(input.prompt).toContain(OPENROUTER_ACP_SMOKE_SUCCESS_MARKER);
        expect(input.prompt).not.toContain(testKey);
        expect(config.agents.codex.args).toEqual(
          normalConfig.agents.codex.args,
        );
        return {
          agent: "codex",
          role: config.agents.codex.role,
          status: "completed",
          rawText: `${OPENROUTER_ACP_SMOKE_SUCCESS_MARKER}\n`,
          startedAt: "2026-07-15T00:00:00.000Z",
          completedAt: "2026-07-15T00:00:01.000Z",
        };
      },
    });

    expect(output).toBe("OpenRouter Codex ACP smoke passed.");
    expect(output).not.toContain(testKey);
    expect(existsSync(workspaceDir)).toBe(false);
    expect(existsSync(childEnv?.HOME ?? "")).toBe(false);
    expect(existsSync(childEnv?.CODEX_HOME ?? "")).toBe(false);
  });

  test("does not expose ACP output when the success marker is absent", async () => {
    let message = "";
    try {
      await runOpenRouterCodexAcpSmoke({
        env: smokeEnv,
        runAgent: async (input, config) => ({
          agent: "codex",
          role: config.agents.codex.role,
          status: "completed",
          rawText: `unexpected response ${OPENROUTER_ACP_SMOKE_SUCCESS_MARKER} ${testKey}`,
          startedAt: "2026-07-15T00:00:00.000Z",
          completedAt: "2026-07-15T00:00:01.000Z",
        }),
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("required success marker");
    expect(message).not.toContain(testKey);
  });

  test("rejects positional values and flags so credentials cannot be accepted from argv", () => {
    expect(() =>
      assertOpenRouterCodexAcpSmokeArguments({
        positionals: [testKey],
        flags: {},
      }),
    ).toThrow("accepts no arguments");
    expect(() =>
      assertOpenRouterCodexAcpSmokeArguments({
        positionals: [],
        flags: { key: testKey },
      }),
    ).toThrow("accepts no arguments");
  });

  test("keeps credentials out of the package smoke command argv", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    const command = packageJson.scripts?.["smoke:openrouter:codex-acp"];

    expect(command).toBe("bun run src/cli/main.ts openrouter-acp-smoke");
    expect(command).not.toContain("OPENROUTER_API_KEY");
    expect(command).not.toContain(OPENROUTER_ACP_SMOKE_MODEL_ENV);
  });
});

function omit(env: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[key];
  return copy;
}
