import { describe, expect, test } from "bun:test";
import {
  CODEX_PLUGIN_INSPECTION_TIMEOUT_MS,
  formatCodexInspectionFailure,
  inspectCodexMcpList,
  inspectCodexPlugin,
  type CodexCommand,
  type CodexCommandResult,
} from "../../src/cli/codexPluginDetector.js";
import {
  MINIMUM_SUPPORTED_CODEX_VERSION,
  PLUGIN_LIST_JSON_SCHEMA,
  PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION,
  PLUGIN_RUNTIME_EXPECTED_CONTRACT,
} from "../../src/cli/pluginRuntimeContract.js";

const cwd = "/workspace";
const env = { HOME: "/home/kyoso", CODEX_HOME: "/state/codex" };

describe("Codex Plugin detector", () => {
  test("uses the bundled probe contract", () => {
    expect(PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION).toBe(2);
    expect(MINIMUM_SUPPORTED_CODEX_VERSION).toBe("0.144.0-alpha.4");
    expect(PLUGIN_RUNTIME_EXPECTED_CONTRACT.marketplace.pluginId).toBe(
      "kyoso@kyoso",
    );
    expect(PLUGIN_RUNTIME_EXPECTED_CONTRACT.distribution.mcpExecutable).toBe(
      "kyoso",
    );
    expect(PLUGIN_LIST_JSON_SCHEMA.collections).toEqual([
      "installed",
      "available",
    ]);
  });

  test("reports an installed and enabled Plugin from the probe-backed schema", () => {
    const runner = scriptedRunner({
      "--version": completed("codex-cli 0.144.1\n"),
      "plugin list --json": completed(
        JSON.stringify({
          installed: [pluginEntry({ installed: true, enabled: true })],
          available: [],
        }),
      ),
    });

    expect(
      inspectCodexPlugin({ cwd, env, timeoutMs: 1234, runCodex: runner.run }),
    ).toEqual({
      status: "supported",
      codexVersion: "0.144.1",
      plugin: {
        pluginId: "kyoso@kyoso",
        installed: true,
        enabled: true,
        state: "enabled",
      },
    });
    expect(runner.calls).toEqual([
      { args: ["--version"], cwd, env, timeoutMs: 1234 },
      { args: ["plugin", "list", "--json"], cwd, env, timeoutMs: 1234 },
    ]);
  });

  test("finds the Codex version line among diagnostic output", () => {
    const runner = scriptedRunner({
      "--version": completed(
        "npm warning before version\r\ncodex-cli 0.144.1\r\nupdate notice",
      ),
      "plugin list --json": completed(JSON.stringify({ installed: [] })),
    });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toMatchObject({
      status: "supported",
      codexVersion: "0.144.1",
    });
  });

  test("reports disabled and not-installed Plugin states without treating them as unsupported", () => {
    const disabled = scriptedRunner({
      "--version": completed("codex-cli 0.144.0-alpha.4"),
      "plugin list --json": completed(
        JSON.stringify({
          installed: [pluginEntry({ installed: true, enabled: false })],
        }),
      ),
    });
    const absent = scriptedRunner({
      "--version": completed("codex-cli 0.144.1"),
      "plugin list --json": completed(
        JSON.stringify({
          available: [pluginEntry({ pluginId: "other@marketplace" })],
        }),
      ),
    });

    expect(inspectCodexPlugin({ cwd, runCodex: disabled.run })).toMatchObject({
      status: "supported",
      plugin: { state: "disabled", installed: true, enabled: false },
    });
    expect(inspectCodexPlugin({ cwd, runCodex: absent.run })).toMatchObject({
      status: "supported",
      plugin: { state: "not_installed", installed: false, enabled: false },
    });
  });

  test("fails closed for a Codex version below the recorded minimum", () => {
    const runner = scriptedRunner({
      "--version": completed("codex-cli 0.144.0-alpha.3"),
    });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toEqual({
      status: "unsupported",
      failure: { operation: "version", reason: "unsupported_version" },
    });
    expect(runner.calls).toHaveLength(1);
  });

  test.each([
    ["unavailable", { kind: "unavailable" }],
    ["timeout", { kind: "timeout" }],
    ["non-zero", { kind: "failed" }],
  ] as const)("fails closed when the version command is %s", (_, result) => {
    const runner = scriptedRunner({ "--version": result });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toMatchObject({
      status: "unsupported",
      failure: { operation: "version" },
    });
    expect(runner.calls).toHaveLength(1);
  });

  test.each([
    ["timeout", { kind: "timeout" }],
    ["non-zero exit", { kind: "failed" }],
  ] as const)("fails closed when Plugin list is %s", (_, result) => {
    const runner = scriptedRunner({
      "--version": completed("codex-cli 0.144.1"),
      "plugin list --json": result,
    });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toMatchObject({
      status: "unsupported",
      failure: { operation: "plugin_list" },
    });
  });

  test.each([
    ["invalid JSON", "not-json", "invalid_output"],
    [
      "unknown top-level key",
      JSON.stringify({ installed: [], available: [], future: true }),
      "unknown_schema",
    ],
    [
      "missing target booleans",
      JSON.stringify({
        installed: [{ pluginId: "kyoso@kyoso", installed: true }],
      }),
      "unknown_schema",
    ],
    [
      "duplicate target entries",
      JSON.stringify({
        installed: [pluginEntry()],
        available: [pluginEntry()],
      }),
      "unknown_schema",
    ],
  ] as const)("fails closed for Plugin list %s", (_, stdout, reason) => {
    const runner = scriptedRunner({
      "--version": completed("codex-cli 0.144.1"),
      "plugin list --json": completed(stdout),
    });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toEqual({
      status: "unsupported",
      failure: { operation: "plugin_list", reason },
    });
  });

  test("fails closed for an invalid Codex version format", () => {
    const runner = scriptedRunner({ "--version": completed("codex 0.144.1") });

    expect(inspectCodexPlugin({ cwd, runCodex: runner.run })).toEqual({
      status: "unsupported",
      failure: { operation: "version", reason: "invalid_output" },
    });
  });

  test("caps an injected inspection timeout", () => {
    const runner = scriptedRunner({
      "--version": completed("codex-cli 0.144.1"),
      "plugin list --json": completed(JSON.stringify({ installed: [] })),
    });

    inspectCodexPlugin({
      cwd,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      runCodex: runner.run,
    });

    expect(runner.calls[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(CODEX_PLUGIN_INSPECTION_TIMEOUT_MS).toBeGreaterThan(0);
  });

  test("inspects the effective MCP list only when the caller explicitly asks", () => {
    const runner = scriptedRunner({
      "mcp list --json": completed(
        JSON.stringify([{ name: "kyoso", enabled: false }]),
      ),
    });

    expect(inspectCodexMcpList({ cwd, env, runCodex: runner.run })).toEqual({
      status: "supported",
      kyoso: "disabled",
    });
    expect(runner.calls).toEqual([
      { args: ["mcp", "list", "--json"], cwd, env, timeoutMs: 5000 },
    ]);
  });

  test.each([
    ["missing", JSON.stringify([]), { status: "supported", kyoso: "missing" }],
    [
      "unknown target schema",
      JSON.stringify([{ name: "kyoso", enabled: "yes" }]),
      { status: "supported", kyoso: "unknown" },
    ],
    [
      "timeout",
      { kind: "timeout" },
      {
        status: "unsupported",
        failure: { operation: "mcp_list", reason: "timeout" },
      },
    ],
    [
      "unknown list schema",
      JSON.stringify({ servers: [] }),
      {
        status: "unsupported",
        failure: { operation: "mcp_list", reason: "unknown_schema" },
      },
    ],
  ] as const)(
    "handles MCP list %s without inferring an enabled state",
    (_, input, expected) => {
      const result =
        typeof input === "string"
          ? completed(input)
          : (input as CodexCommandResult);
      const runner = scriptedRunner({ "mcp list --json": result });

      expect(inspectCodexMcpList({ cwd, runCodex: runner.run })).toEqual(
        expected,
      );
    },
  );

  test("formats only a fixed failure reason", () => {
    const message = formatCodexInspectionFailure({
      operation: "plugin_list",
      reason: "command_failed",
    });

    expect(message).toBe("Codex Plugin list could not be inspected.");
    expect(message).not.toContain("/Users/");
    expect(message).not.toContain("secret");
  });
});

function scriptedRunner(responses: Record<string, CodexCommandResult>): {
  calls: CodexCommand[];
  run: (command: CodexCommand) => CodexCommandResult;
} {
  const calls: CodexCommand[] = [];
  return {
    calls,
    run(command) {
      calls.push(command);
      return responses[command.args.join(" ")] ?? { kind: "failed" };
    },
  };
}

function completed(stdout: string): CodexCommandResult {
  return { kind: "completed", exitCode: 0, stdout };
}

function pluginEntry(
  overrides: Partial<{
    pluginId: string;
    installed: boolean;
    enabled: boolean;
  }> = {},
) {
  return {
    pluginId: "kyoso@kyoso",
    installed: false,
    enabled: false,
    ...overrides,
  };
}
