import { describe, expect, test } from "bun:test";
import {
  buildKyosoPackageCommand,
  formatKyosoPackageCommand,
} from "../../src/cli/packageRunner.js";

describe("Kyoso package runner", () => {
  test("builds exact npx and bunx commands without mutating cli args", () => {
    const cliArgs = ["mcp"];

    expect(buildKyosoPackageCommand({ runner: "npx", cliArgs })).toEqual({
      command: "npx",
      args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
    });
    expect(
      buildKyosoPackageCommand({
        runner: "npx",
        version: "0.13.1",
        cliArgs,
      }),
    ).toEqual({
      command: "npx",
      args: ["-y", "--package=@kyo-so/cli@0.13.1", "kyoso", "mcp"],
    });
    expect(buildKyosoPackageCommand({ runner: "bunx", cliArgs })).toEqual({
      command: "bunx",
      args: ["--package", "@kyo-so/cli", "kyoso", "mcp"],
    });
    expect(
      buildKyosoPackageCommand({
        runner: "bunx",
        version: "0.13.1",
        cliArgs,
      }),
    ).toEqual({
      command: "bunx",
      args: ["--package", "@kyo-so/cli@0.13.1", "kyoso", "mcp"],
    });
    expect(cliArgs).toEqual(["mcp"]);
  });

  test.each(["latest", "^0.13.1", "", " 0.13.1", "1.2.3-01", "1.2.3-alpha.01"])(
    "rejects non-SemVer package version %p",
    (version) => {
      expect(() =>
        buildKyosoPackageCommand({ runner: "npx", version, cliArgs: ["mcp"] }),
      ).toThrow("complete SemVer");
    },
  );

  test("formats an explicit human-readable command", () => {
    expect(
      formatKyosoPackageCommand({
        runner: "npx",
        cliArgs: ["setup", "codex", "--write"],
      }),
    ).toBe("npx -y --package=@kyo-so/cli kyoso setup codex --write");
  });
});
