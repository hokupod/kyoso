import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The promotion command is intentionally shipped as a standalone Node.js script.
import * as pluginPromote from "../../scripts/plugin-promote.mjs";

const { restoreCommittedUpdates, runPluginPromotion, writeUpdatesAtomically } =
  pluginPromote;
// @ts-expect-error The published verifier is intentionally shipped as a standalone Node.js script.
import { verifyPublishedCliTarget } from "../../scripts/verify-published-cli.mjs";

const current = {
  packageName: "@kyo-so/cli",
  packageVersion: "0.13.1",
  pluginVersion: "0.7.2",
};
const options = { cliVersion: "0.13.2", pluginVersion: "0.7.3", write: false };

describe("Plugin promotion runtime gate", () => {
  test.each(["npx", "bunx"])(
    "does not create or write updates when %s smoke fails",
    async (failingRunner) => {
      const root = await promotionRoot();
      const events: string[] = [];
      try {
        await expect(
          runPluginPromotion(options, {
            root,
            verifyDistribution: distributionVerifier(events),
            verifyPublished: publishedVerifier(events, failingRunner),
            createPromotionUpdates: () => {
              events.push("create");
              return [];
            },
            writePromotionUpdates: () => {
              events.push("write");
              return { committed: [] };
            },
            log: (message: string) => events.push(`log:${message}`),
          }),
        ).rejects.toThrow(`${failingRunner} smoke failure`);

        expect(events).toEqual(
          failingRunner === "npx"
            ? ["distribution", "metadata", "npx"]
            : ["distribution", "metadata", "npx", "bunx"],
        );
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  test.each([
    "execution quarantine",
    "wrong server version",
    "wrong tool set",
    "ambient sentinel invocation",
    "safe-chain shim error",
  ])("fails closed for %s without a bypass", async (reason) => {
    const root = await promotionRoot();
    const events: string[] = [];
    try {
      await expect(
        runPluginPromotion(options, {
          root,
          verifyDistribution: distributionVerifier(events),
          verifyPublished: publishedVerifier(events, "npx", reason),
          createPromotionUpdates: () => {
            events.push("create");
            return [];
          },
          log: (message: string) => events.push(`log:${message}`),
        }),
      ).rejects.toThrow(reason);
      expect(events).toEqual(["distribution", "metadata", "npx"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("orders metadata, both runners, update creation, write, verification, then success", async () => {
    const root = await promotionRoot();
    const events: string[] = [];
    const updates: unknown[] = [];
    try {
      await expect(
        runPluginPromotion(
          { ...options, write: true },
          {
            root,
            verifyDistribution: ({
              expectedPackageVersion,
            }: {
              expectedPackageVersion?: string;
            }) => {
              events.push(
                expectedPackageVersion ? "post-verify" : "distribution",
              );
              return current;
            },
            verifyPublished: publishedVerifier(events),
            createPromotionUpdates: () => {
              events.push("create");
              return updates;
            },
            writePromotionUpdates: (entries: unknown[]) => {
              events.push("write");
              return { committed: entries };
            },
            restorePromotionUpdates: () => {
              events.push("restore");
            },
            log: (message: string) => events.push(`log:${message}`),
          },
        ),
      ).resolves.toMatchObject({ action: "updated" });

      expect(events.slice(0, 6)).toEqual([
        "distribution",
        "metadata",
        "npx",
        "bunx",
        "create",
        "write",
      ]);
      expect(events).toContain("post-verify");
      expect(events).not.toContain("restore");
      expect(
        events.some((event) =>
          event.startsWith("log:plugin promotion updated"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("keeps dry-run behind the same runtime gate", async () => {
    const root = await promotionRoot();
    const events: string[] = [];
    try {
      await expect(
        runPluginPromotion(options, {
          root,
          verifyDistribution: distributionVerifier(events),
          verifyPublished: publishedVerifier(events),
          createPromotionUpdates: () => {
            events.push("create");
            return [];
          },
          writePromotionUpdates: () => {
            events.push("write");
            return { committed: [] };
          },
          log: (message: string) => events.push(`log:${message}`),
        }),
      ).resolves.toMatchObject({ action: "dry-run" });

      expect(events.slice(0, 5)).toEqual([
        "distribution",
        "metadata",
        "npx",
        "bunx",
        "create",
      ]);
      expect(events).not.toContain("write");
      expect(
        events.some((event) =>
          event.startsWith("log:plugin promotion dry-run"),
        ),
      ).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores every committed byte and mode after post-write verification fails", async () => {
    const root = await promotionRoot();
    const updates = await promotionUpdates(root);
    const before = await snapshotUpdates(updates);
    const events: string[] = [];
    let genericVerificationCalls = 0;
    try {
      await expect(
        runPluginPromotion(
          { ...options, write: true },
          {
            root,
            verifyDistribution: ({
              expectedPackageVersion,
            }: {
              expectedPackageVersion?: string;
            }) => {
              if (expectedPackageVersion) {
                events.push("post-verify");
                throw new Error("injected post-write verification failure");
              }
              genericVerificationCalls += 1;
              events.push(
                genericVerificationCalls === 1 ? "distribution" : "old-verify",
              );
              return current;
            },
            verifyPublished: publishedVerifier(events),
            createPromotionUpdates: () => {
              events.push("create");
              return updates;
            },
            log: (message: string) => events.push(`log:${message}`),
          },
        ),
      ).rejects.toThrow("original distribution was restored");

      expect(events).toContain("old-verify");
      expect(await snapshotUpdates(updates)).toEqual(before);
      expect(temporaryPromotionFiles(root)).toEqual([]);
      expect(
        events.some((event) =>
          event.startsWith("log:plugin promotion updated"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores committed updates when post-rename cleanup fails", async () => {
    const root = await promotionRoot();
    const updates = await promotionUpdates(root);
    const before = await snapshotUpdates(updates);
    const events: string[] = [];
    let genericVerificationCalls = 0;

    try {
      await expect(
        runPluginPromotion(
          { ...options, write: true },
          {
            root,
            verifyDistribution: ({
              expectedPackageVersion,
            }: {
              expectedPackageVersion?: string;
            }) => {
              genericVerificationCalls += 1;
              events.push(
                expectedPackageVersion
                  ? "post-verify"
                  : genericVerificationCalls === 1
                    ? "distribution"
                    : "old-verify",
              );
              return current;
            },
            verifyPublished: publishedVerifier(events),
            createPromotionUpdates: () => updates,
            writePromotionUpdates: (entries: unknown[]) =>
              writeUpdatesAtomically(entries, {
                removeTemporary: () => {
                  throw new Error("injected post-rename cleanup failure");
                },
              }),
            log: (message: string) => events.push(`log:${message}`),
          },
        ),
      ).rejects.toThrow("temporary cleanup failed");

      expect(events).toContain("old-verify");
      expect(events).not.toContain("post-verify");
      expect(await snapshotUpdates(updates)).toEqual(before);
      expect(temporaryPromotionFiles(root)).toEqual([]);
      expect(
        events.some((event) =>
          event.startsWith("log:plugin promotion updated"),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves modes through promotion and rollback despite umask", async () => {
    const root = await promotionRoot();
    const updates = await promotionUpdates(root, 0o664);
    const before = await snapshotUpdates(updates);
    const previousUmask = process.umask(0o022);

    try {
      const { committed } = writeUpdatesAtomically(updates);
      expect(await snapshotUpdates(updates)).toEqual(
        before.map((entry, index) => ({
          ...entry,
          bytes: Buffer.from(updates[index]!.next).toString("hex"),
        })),
      );

      restoreCommittedUpdates(committed);
      expect(await snapshotUpdates(updates)).toEqual(before);
    } finally {
      process.umask(previousUmask);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("continues rollback after one injected entry failure and reports its path", async () => {
    const root = await promotionRoot();
    const updates = await promotionUpdates(root);
    try {
      const { committed } = writeUpdatesAtomically(updates);
      const failing = committed[3];
      const attempted: string[] = [];

      expect(() =>
        restoreCommittedUpdates(committed, {
          beforeRestoreEntry: (entry: { path: string }) => {
            attempted.push(entry.path);
            if (entry.path === failing.path) {
              throw new Error("injected restore failure");
            }
          },
        }),
      ).toThrow(failing.path);

      expect(attempted).toHaveLength(committed.length);
      for (const entry of committed) {
        const contents = await readFile(entry.path);
        if (entry.path === failing.path) {
          expect(contents.equals(Buffer.from(entry.next))).toBe(true);
        } else {
          expect(contents.equals(Buffer.from(entry.current))).toBe(true);
        }
      }
      expect(temporaryPromotionFiles(root)).toEqual([]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("continues rollback after a temporary cleanup failure", async () => {
    const root = await promotionRoot();
    const updates = await promotionUpdates(root);
    try {
      const { committed } = writeUpdatesAtomically(updates);
      const cleanupAttempts: string[] = [];

      expect(() =>
        restoreCommittedUpdates(committed, {
          removeTemporary: (path: string) => {
            cleanupAttempts.push(path);
            if (cleanupAttempts.length === 1) {
              throw new Error("injected cleanup failure");
            }
            rmSync(path, { force: true });
          },
        }),
      ).toThrow("could not remove rollback temporary file");

      expect(cleanupAttempts).toHaveLength(committed.length);
      for (const entry of committed) {
        expect(
          (await readFile(entry.path)).equals(Buffer.from(entry.current)),
        ).toBe(true);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not accept a published-verification skip option", () => {
    const result = spawnSync(
      "node",
      [
        "scripts/plugin-promote.mjs",
        "--cli-version",
        "0.13.2",
        "--plugin-version",
        "0.7.3",
        "--skip-published-cli",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage:");
  });

  test("does not treat environment state as a published-verification receipt", async () => {
    const root = await promotionRoot();
    const events: string[] = [];
    const priorSkip = process.env.KYOSO_SKIP_PUBLISHED_CLI;
    const priorReceipt = process.env.KYOSO_PUBLISHED_CLI_RECEIPT;
    process.env.KYOSO_SKIP_PUBLISHED_CLI = "1";
    process.env.KYOSO_PUBLISHED_CLI_RECEIPT = "already-verified";
    try {
      await expect(
        runPluginPromotion(options, {
          root,
          verifyDistribution: distributionVerifier(events),
          verifyPublished: publishedVerifier(events, "npx"),
          createPromotionUpdates: () => {
            events.push("create");
            return [];
          },
        }),
      ).rejects.toThrow("npx smoke failure");
      expect(events).toEqual(["distribution", "metadata", "npx"]);
    } finally {
      if (priorSkip === undefined) delete process.env.KYOSO_SKIP_PUBLISHED_CLI;
      else process.env.KYOSO_SKIP_PUBLISHED_CLI = priorSkip;
      if (priorReceipt === undefined)
        delete process.env.KYOSO_PUBLISHED_CLI_RECEIPT;
      else process.env.KYOSO_PUBLISHED_CLI_RECEIPT = priorReceipt;
      await rm(root, { force: true, recursive: true });
    }
  });
});

function publishedVerifier(
  events: string[],
  failingRunner?: string,
  failureMessage?: string,
) {
  return (target: typeof current) =>
    verifyPublishedCliTarget(target, {
      assertPublished: async ({
        packageName,
        packageVersion,
      }: typeof current) => {
        events.push("metadata");
        return `${packageName}@${packageVersion}`;
      },
      runSmoke: async ({ runner }: { runner: string }) => {
        events.push(runner);
        if (runner === failingRunner) {
          throw new Error(failureMessage ?? `${runner} smoke failure`);
        }
      },
    });
}

function distributionVerifier(events: string[]) {
  return () => {
    events.push("distribution");
    return current;
  };
}

async function promotionRoot() {
  const root = await mkdtemp(join(tmpdir(), "kyoso-plugin-promote-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ version: options.cliVersion })}\n`,
    "utf8",
  );
  return root;
}

async function promotionUpdates(root: string, mode = 0o640) {
  const updates = [];
  for (let index = 0; index < 7; index += 1) {
    const path = join(root, `target-${index}.txt`);
    const currentBytes = Buffer.from(`original-${index}\n`);
    await writeFile(path, currentBytes);
    chmodSync(path, mode);
    updates.push({
      path,
      current: currentBytes,
      next: `updated-${index}\n`,
      mode,
    });
  }
  return updates;
}

async function snapshotUpdates(updates: Array<{ path: string }>) {
  return Promise.all(
    updates.map(async (entry) => ({
      bytes: (await readFile(entry.path)).toString("hex"),
      mode: statSync(entry.path).mode & 0o777,
    })),
  );
}

function temporaryPromotionFiles(root: string) {
  return readdirSync(root).filter(
    (name) =>
      name.includes(".plugin-promote-") || name.includes(".plugin-rollback-"),
  );
}
