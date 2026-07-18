import { describe, expect, test } from "bun:test";
import { inspectManualMcpInvocation } from "../../src/cli/manualMcpInvocation.js";

describe("manual MCP invocation classifier", () => {
  test.each([
    [
      "current npx",
      "npx",
      ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
      "current",
    ],
    [
      "current pinned npx",
      "npx",
      ["-y", "--package=@kyo-so/cli@0.13.1", "kyoso", "mcp"],
      "current",
    ],
    [
      "current bunx",
      "bunx",
      ["--package", "@kyo-so/cli", "kyoso", "mcp"],
      "current",
    ],
    ["legacy npx", "npx", ["-y", "@kyo-so/cli", "mcp"], "legacy"],
    ["legacy npx without yes", "npx", ["@kyo-so/cli@0.13.1", "mcp"], "legacy"],
    ["legacy bunx", "bunx", ["@kyo-so/cli@0.13.1", "mcp"], "legacy"],
    ["tag", "npx", ["-y", "@kyo-so/cli@latest", "mcp"], "custom"],
    ["range", "bunx", ["@kyo-so/cli@^0.13.1", "mcp"], "custom"],
    [
      "wrong executable",
      "npx",
      ["-y", "--package=@kyo-so/cli", "cli", "mcp"],
      "custom",
    ],
    [
      "extra arg",
      "bunx",
      ["--package", "@kyo-so/cli", "kyoso", "--verbose", "mcp"],
      "custom",
    ],
  ] as const)("classifies %s", (_label, command, args, expectedKind) => {
    expect(inspectManualMcpInvocation({ command, args }).kind).toBe(
      expectedKind,
    );
  });

  test("only exposes a replacement for exact legacy forms", () => {
    expect(
      inspectManualMcpInvocation({
        command: "npx",
        args: ["-y", "@kyo-so/cli@0.13.1", "mcp"],
      }),
    ).toMatchObject({
      kind: "legacy",
      replacement: {
        command: "npx",
        args: ["-y", "--package=@kyo-so/cli@0.13.1", "kyoso", "mcp"],
      },
    });
    expect(
      inspectManualMcpInvocation({
        command: "npx",
        args: ["-y", "@kyo-so/cli@latest", "mcp"],
      }).replacement,
    ).toBeUndefined();
  });

  test("keeps generated credential placeholders current", () => {
    expect(
      inspectManualMcpInvocation({
        command: "npx",
        args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
        env: {
          OPENAI_API_KEY: "${OPENAI_API_KEY}",
          ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY}",
        },
      }).kind,
    ).toBe("current");
    expect(
      inspectManualMcpInvocation({
        command: "bunx",
        args: ["--package", "@kyo-so/cli", "kyoso", "mcp"],
        env_vars: ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"],
      }).kind,
    ).toBe("current");
  });

  test.each([
    ["environment mapping", { NODE_OPTIONS: "--require /tmp/payload.js" }],
    ["environment forwarding", ["npm_config_registry"]],
  ] as const)(
    "classifies execution-altering %s as custom",
    (_label, environment) => {
      const entry = {
        command: "npx",
        args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
        ...(Array.isArray(environment)
          ? { env_vars: environment }
          : { env: environment }),
      };
      expect(inspectManualMcpInvocation(entry)).toMatchObject({
        kind: "custom",
      });
    },
  );

  test("does not expose a replacement for legacy argv with an unsafe environment", () => {
    const inspection = inspectManualMcpInvocation({
      command: "npx",
      args: ["-y", "@kyo-so/cli", "mcp"],
      env: { NODE_OPTIONS: "--require /tmp/payload.js" },
    });
    expect(inspection).toMatchObject({
      kind: "custom",
    });
    expect(inspection.replacement).toBeUndefined();
  });

  test("classifies malformed values as unknown", () => {
    expect(
      inspectManualMcpInvocation({ command: "npx", args: ["mcp", 1] }),
    ).toMatchObject({
      kind: "unknown",
    });
    expect(inspectManualMcpInvocation({ args: [] })).toMatchObject({
      kind: "unknown",
    });
  });
});
