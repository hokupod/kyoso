import { describe, expect, test } from "bun:test";
import {
  buildKyosoPackageCommand,
  formatKyosoPackageCommand,
} from "../../src/cli/packageRunner.js";
// @ts-expect-error The registry validator is intentionally shipped as a standalone Node.js script.
import { validatePublishedCliMetadata } from "../../scripts/plugin-registry.mjs";

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

  test.each([
    [
      "accepts a multi-bin published package",
      {
        name: "@kyo-so/cli",
        version: "0.13.1",
        bin: {
          kyoso: "dist/bin/kyoso.js",
          "kyoso-budget-report": "scripts/review-budget-report.mjs",
        },
      },
      undefined,
    ],
    [
      "rejects a missing primary executable",
      { name: "@kyo-so/cli", version: "0.13.1", bin: {} },
      "bin.kyoso",
    ],
    [
      "rejects a wrong primary executable path",
      {
        name: "@kyo-so/cli",
        version: "0.13.1",
        bin: { kyoso: "dist/bin/other.js" },
      },
      "bin.kyoso",
    ],
    [
      "rejects a wrong package name",
      {
        name: "@other/cli",
        version: "0.13.1",
        bin: { kyoso: "dist/bin/kyoso.js" },
      },
      "metadata name",
    ],
    [
      "rejects a wrong package version",
      {
        name: "@kyo-so/cli",
        version: "0.13.0",
        bin: { kyoso: "dist/bin/kyoso.js" },
      },
      "does not list",
    ],
  ])("%s", (_name, payload, expectedError) => {
    const options = { packageName: "@kyo-so/cli", packageVersion: "0.13.1" };

    if (expectedError) {
      expect(() => validatePublishedCliMetadata(payload, options)).toThrow(
        expectedError,
      );
      return;
    }
    expect(validatePublishedCliMetadata(payload, options)).toBe(
      "@kyo-so/cli@0.13.1",
    );
  });
});
