import { describe, expect, test } from "bun:test";
// @ts-expect-error The published-artifact verifier is intentionally shipped as a standalone Node.js script.
import * as publishedCli from "../../scripts/verify-published-cli.mjs";

const { parsePublishedCliOptions, verifyPublishedCliTarget } = publishedCli;

const target = { packageName: "@kyo-so/cli", packageVersion: "0.13.1" };

describe("published CLI verification", () => {
  test("verifies registry metadata then npx and bunx with exact explicit argv", async () => {
    const events: string[] = [];
    const smokeRequests: any[] = [];

    await expect(
      verifyPublishedCliTarget(target, {
        assertPublished: async (request: typeof target) => {
          events.push(
            `metadata:${request.packageName}@${request.packageVersion}`,
          );
          return `${request.packageName}@${request.packageVersion}`;
        },
        runSmoke: async (request: any) => {
          events.push(`smoke:${request.runner}`);
          smokeRequests.push(request);
        },
      }),
    ).resolves.toBe("@kyo-so/cli@0.13.1");

    expect(events).toEqual([
      "metadata:@kyo-so/cli@0.13.1",
      "smoke:npx",
      "smoke:bunx",
    ]);
    expect(smokeRequests).toEqual([
      expect.objectContaining({
        runner: "npx",
        command: "npx",
        args: [
          "-y",
          "--package=@kyo-so/cli@0.13.1",
          "kyoso",
          "mcp",
          "--ignore-config",
          "--network",
          "model_only",
        ],
        expectedVersion: "0.13.1",
        published: true,
      }),
      expect.objectContaining({
        runner: "bunx",
        command: "bunx",
        args: [
          "--package",
          "@kyo-so/cli@0.13.1",
          "kyoso",
          "mcp",
          "--ignore-config",
          "--network",
          "model_only",
        ],
        expectedVersion: "0.13.1",
        published: true,
      }),
    ]);
  });

  test("fails closed before Bun when npx smoke fails", async () => {
    const events: string[] = [];

    await expect(
      verifyPublishedCliTarget(target, {
        assertPublished: async () => {
          events.push("metadata");
          return "@kyo-so/cli@0.13.1";
        },
        runSmoke: async ({ runner }: { runner: string }) => {
          events.push(runner);
          if (runner === "npx") throw new Error("npx smoke failure");
        },
      }),
    ).rejects.toThrow("npx smoke failure");

    expect(events).toEqual(["metadata", "npx"]);
  });

  test.each([
    [
      "rejects another package",
      { packageName: "other", packageVersion: "0.13.1" },
    ],
    ["rejects a tag", { packageName: "@kyo-so/cli", packageVersion: "latest" }],
    [
      "rejects a range",
      { packageName: "@kyo-so/cli", packageVersion: "^0.13.1" },
    ],
  ])("%s", async (_name, invalidTarget) => {
    await expect(verifyPublishedCliTarget(invalidTarget)).rejects.toThrow();
  });

  test("parses only an optional complete SemVer version", () => {
    expect(parsePublishedCliOptions([])).toEqual({});
    expect(parsePublishedCliOptions(["--version", "0.13.1"])).toEqual({
      version: "0.13.1",
    });
    expect(() => parsePublishedCliOptions(["--version", "latest"])).toThrow(
      "complete SemVer",
    );
    expect(() => parsePublishedCliOptions(["--skip-published-cli"])).toThrow(
      "Usage",
    );
  });
});
