import { describe, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

describe("Plugin promotion reminder reconciliation", () => {
  test("selects only exact resolved reminders", () => {
    runModuleTest(`
      const issue = (number, target, pin = "1.2.0") => ({
        number,
        title:
          "Plugin promotion needed: CLI v" +
          target +
          " released, plugins pin v" +
          pin,
        body:
          "<!-- kyoso:plugin-promotion-reminder cli=" +
          target +
          " -->\\n\\nReminder",
      });

      const parsed = parsePromotionReminderIssue(issue(1, "1.2.2"));
      assert.equal(parsed.targetVersion, "1.2.2");

      const selected = selectClosablePromotionReminderIssues(
        [
          issue(4, "1.2.3-beta.1"),
          issue(3, "1.2.4"),
          issue(2, "1.2.3"),
          issue(1, "1.2.2"),
          {
            number: 5,
            title:
              "Plugin promotion needed: CLI v1.2.2 released, plugins pin v1.2.0",
            body: "Legacy markerless reminder",
          },
          {
            number: 6,
            title: "Unrelated issue",
            body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.2 -->",
          },
          { ...issue(7, "1.2.2"), pull_request: { url: "https://example.test" } },
        ],
        "1.2.3",
      );

      assert.deepEqual(
        selected.map(({ number }) => number),
        [1, 2, 4],
      );
    `);
  });

  test("rejects malformed targeted reminders before selection", () => {
    runModuleTest(`
      const cases = [
        {
          number: 1,
          title:
            "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.0",
          body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.2 -->",
        },
        {
          number: 2,
          title:
            "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.0",
          body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.3-->",
        },
        {
          number: 3,
          title:
            "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.0",
          body:
            "<!-- kyoso:plugin-promotion-reminder cli=1.2.3 -->\\n" +
            "<!-- kyoso:plugin-promotion-reminder cli=1.2.3 -->",
        },
        {
          number: 4,
          title:
            "Plugin promotion needed: CLI v1.2.3-01 released, plugins pin v1.2.0",
          body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.3-01 -->",
        },
        {
          number: 5,
          title: "Plugin promotion needed: CLI v1.2.3",
          body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.3 -->",
        },
      ];

      for (const issue of cases) {
        assert.throws(
          () => selectClosablePromotionReminderIssues([issue], "1.2.3"),
          /Promotion reminder issue/,
        );
      }
    `);
  });

  test("verifies distribution and writes complete audit comments", () => {
    runModuleTest(`
      const fixture = mkdtempSync(join(tmpdir(), "kyoso-promotion-issues-"));
      try {
        writeFileSync(
          join(fixture, "package.json"),
          JSON.stringify({ version: "1.2.3" }),
        );
        const env = {
          GITHUB_REPOSITORY: "hokupod/kyoso",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "123456",
        };
        const closed = [];
        const logs = [];
        const result = await runPluginPromotionIssueReconciliation(
          { root: fixture, env },
          {
            verifyDistribution(options) {
              assert.deepEqual(options, {
                root: fixture,
                verifyPackageArchive: false,
                expectedPackageVersion: "1.2.3",
              });
              return {
                packageVersion: "1.2.3",
                pluginVersion: "0.7.8",
              };
            },
            listOpenIssues({ repository }) {
              assert.equal(repository, "hokupod/kyoso");
              return [
                {
                  number: 12,
                  title:
                    "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.2",
                  body:
                    "<!-- kyoso:plugin-promotion-reminder cli=1.2.3 -->",
                },
                {
                  number: 11,
                  title:
                    "Plugin promotion needed: CLI v1.2.2 released, plugins pin v1.2.1",
                  body:
                    "<!-- kyoso:plugin-promotion-reminder cli=1.2.2 -->",
                },
                {
                  number: 13,
                  title:
                    "Plugin promotion needed: CLI v1.2.4 released, plugins pin v1.2.3",
                  body:
                    "<!-- kyoso:plugin-promotion-reminder cli=1.2.4 -->",
                },
              ];
            },
            closeIssue(options) {
              closed.push(options);
            },
            log(message) {
              logs.push(message);
            },
          },
        );

        assert.deepEqual(result.closed, [11, 12]);
        assert.deepEqual(
          closed.map(({ number }) => number),
          [11, 12],
        );
        for (const closure of closed) {
          assert.equal(closure.repository, "hokupod/kyoso");
          assert.match(
            closure.comment,
            /Plugin promotion verification completed on \`0123456789abcdef0123456789abcdef01234567\`\./,
          );
          assert.match(closure.comment, /Plugin version: \`0\\.7\\.8\`/);
          assert.match(
            closure.comment,
            /Codex MCP pin: \`@kyo-so\\/cli@1\\.2\\.3\`/,
          );
          assert.match(
            closure.comment,
            /Claude Code MCP pin: \`@kyo-so\\/cli@1\\.2\\.3\`/,
          );
          assert.match(
            closure.comment,
            /https:\\/\\/github\\.com\\/hokupod\\/kyoso\\/actions\\/runs\\/123456/,
          );
        }
        assert.equal(logs.length, 2);

        const empty = await runPluginPromotionIssueReconciliation(
          { root: fixture, env },
          {
            verifyDistribution: () => ({
              packageVersion: "1.2.3",
              pluginVersion: "0.7.8",
            }),
            listOpenIssues: () => [],
            closeIssue: () => {
              throw new Error("must not close");
            },
            log() {},
          },
        );
        assert.deepEqual(empty.closed, []);
      } finally {
        rmSync(fixture, { force: true, recursive: true });
      }
    `);
  });

  test("fails before mutation when validation is incomplete", () => {
    runModuleTest(`
      const fixture = mkdtempSync(join(tmpdir(), "kyoso-promotion-issues-"));
      try {
        writeFileSync(
          join(fixture, "package.json"),
          JSON.stringify({ version: "1.2.3" }),
        );
        const validEnv = {
          GITHUB_REPOSITORY: "hokupod/kyoso",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "123456",
        };
        const distribution = () => ({
          packageVersion: "1.2.3",
          pluginVersion: "0.7.8",
        });
        let listed = 0;
        let closed = 0;

        await assert.rejects(
          runPluginPromotionIssueReconciliation(
            { root: fixture, env: validEnv },
            {
              verifyDistribution() {
                throw new Error("distribution mismatch");
              },
              listOpenIssues() {
                listed += 1;
                return [];
              },
              closeIssue() {
                closed += 1;
              },
            },
          ),
          /distribution mismatch/,
        );
        assert.equal(listed, 0);
        assert.equal(closed, 0);

        await assert.rejects(
          runPluginPromotionIssueReconciliation(
            { root: fixture, env: {} },
            {
              verifyDistribution: distribution,
              listOpenIssues() {
                listed += 1;
                return [];
              },
              closeIssue() {
                closed += 1;
              },
            },
          ),
          /GITHUB_REPOSITORY is required/,
        );
        assert.equal(listed, 0);
        assert.equal(closed, 0);

        await assert.rejects(
          runPluginPromotionIssueReconciliation(
            { root: fixture, env: validEnv },
            {
              verifyDistribution: distribution,
              listOpenIssues: () => [
                {
                  number: 1,
                  title:
                    "Plugin promotion needed: CLI v1.2.2 released, plugins pin v1.2.1",
                  body:
                    "<!-- kyoso:plugin-promotion-reminder cli=1.2.2 -->",
                },
                {
                  number: 2,
                  title:
                    "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.2",
                  body:
                    "<!-- kyoso:plugin-promotion-reminder cli=broken -->",
                },
              ],
              closeIssue() {
                closed += 1;
              },
            },
          ),
          /marker target/,
        );
        assert.equal(closed, 0);
      } finally {
        rmSync(fixture, { force: true, recursive: true });
      }
    `);
  });

  test("can resume after a close operation fails", () => {
    runModuleTest(`
      const fixture = mkdtempSync(join(tmpdir(), "kyoso-promotion-issues-"));
      try {
        writeFileSync(
          join(fixture, "package.json"),
          JSON.stringify({ version: "1.2.3" }),
        );
        const env = {
          GITHUB_REPOSITORY: "hokupod/kyoso",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_RUN_ID: "123456",
        };
        const issue = (number) => ({
          number,
          title:
            "Plugin promotion needed: CLI v1.2.3 released, plugins pin v1.2.2",
          body: "<!-- kyoso:plugin-promotion-reminder cli=1.2.3 -->",
        });
        const dependencies = {
          verifyDistribution: () => ({
            packageVersion: "1.2.3",
            pluginVersion: "0.7.8",
          }),
          log() {},
        };
        const attempted = [];

        await assert.rejects(
          runPluginPromotionIssueReconciliation(
            { root: fixture, env },
            {
              ...dependencies,
              listOpenIssues: () => [issue(1), issue(2)],
              closeIssue({ number }) {
                attempted.push(number);
                if (number === 2) throw new Error("temporary close failure");
              },
            },
          ),
          /temporary close failure/,
        );
        assert.deepEqual(attempted, [1, 2]);

        const resumed = await runPluginPromotionIssueReconciliation(
          { root: fixture, env },
          {
            ...dependencies,
            listOpenIssues: () => [issue(2)],
            closeIssue({ number }) {
              attempted.push(number);
            },
          },
        );
        assert.deepEqual(resumed.closed, [2]);
        assert.deepEqual(attempted, [1, 2, 2]);
      } finally {
        rmSync(fixture, { force: true, recursive: true });
      }
    `);
  });
});

function runModuleTest(source: string): void {
  const script = [
    'import assert from "node:assert/strict";',
    'import { mkdtempSync, rmSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    "import {",
    "  parsePromotionReminderIssue,",
    "  runPluginPromotionIssueReconciliation,",
    "  selectClosablePromotionReminderIssues,",
    '} from "./scripts/plugin-promotion-issues.mjs";',
    source,
  ].join("\n");
  const result = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `Plugin promotion issue module test failed:\n${result.stderr || result.stdout}`,
    );
  }
}
