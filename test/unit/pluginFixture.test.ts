import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CURRENT_SKILL_DIGEST } from "../../src/cli/knownSkillDigests.js";
import {
  MINIMUM_SUPPORTED_CODEX_VERSION,
  PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION,
  PLUGIN_RUNTIME_EXPECTED_CONTRACT,
} from "../../src/cli/pluginRuntimeContract.js";
import { hashSkillDirectory } from "../../src/cli/skillInstall.js";

const root = process.cwd();
describe("Codex Plugin fixture", () => {
  test("uses the fixed marketplace, plugin, and MCP identities", async () => {
    const packageMetadata = await readJson(join(root, "package.json"));
    const marketplace = await readJson(
      join(root, ".agents", "plugins", "marketplace.json"),
    );
    const manifest = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "plugin.json"),
    );
    const claudeManifest = await readJson(
      join(root, "plugins", "kyoso", ".claude-plugin", "plugin.json"),
    );
    const mcp = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
    );
    const compatibility = await readJson(
      join(root, "docs", "compatibility", "codex-plugin-runtime.json"),
    );
    const distribution = compatibility.expectedContract.distribution;

    expect(marketplace).toMatchObject({
      name: "kyoso",
      interface: { displayName: "Kyoso" },
      plugins: [
        {
          name: "kyoso",
          source: { source: "local", path: "./plugins/kyoso" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Engineering",
        },
      ],
    });
    expect(manifest).toMatchObject({
      name: "kyoso",
      version: distribution.pluginVersion,
      skills: "./skills/",
      mcpServers: "./.codex-plugin/mcp.json",
      license: "AGPL-3.0-or-later",
      interface: { capabilities: ["Read"] },
    });
    expect(mcp).toEqual({
      kyoso: {
        command: "npx",
        args: ["-y", `--package=${distribution.mcpPackagePin}`, "kyoso", "mcp"],
        env_vars: [
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_HOME",
          "CODEX_ACCESS_TOKEN",
          "OPENROUTER_API_KEY",
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        startup_timeout_sec: 20,
        tool_timeout_sec: 2160,
      },
    });
    expect(claudeManifest.mcpServers.kyoso.env).toEqual({
      ANTHROPIC_API_KEY: "${ANTHROPIC_API_KEY:-}",
      CLAUDE_CODE_OAUTH_TOKEN: "${CLAUDE_CODE_OAUTH_TOKEN:-}",
      OPENROUTER_API_KEY: "${OPENROUTER_API_KEY:-}",
    });
    expect(claudeManifest.mcpServers.kyoso.args).toEqual([
      "-y",
      `--package=${distribution.mcpPackagePin}`,
      "kyoso",
      "mcp",
    ]);
    expect(packageMetadata.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageMetadata.bin).toMatchObject({ kyoso: "dist/bin/kyoso.js" });
    expect(distribution.mcpExecutable).toBe("kyoso");
  });

  test("keeps the Plugin MCP dependency separate from the canonical Skill", async () => {
    const canonical = join(root, ".agents", "skills", "kyoso-review");
    const plugin = join(root, "plugins", "kyoso", "skills", "kyoso-review");
    const canonicalMetadata = await readFile(
      join(canonical, "agents", "openai.yaml"),
      "utf8",
    );
    const pluginMetadata = await readFile(
      join(plugin, "agents", "openai.yaml"),
      "utf8",
    );
    const canonicalInstructions = await readFile(
      join(canonical, "SKILL.md"),
      "utf8",
    );
    const pluginInstructions = await readFile(join(plugin, "SKILL.md"), "utf8");
    const mcp = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
    );
    const cliPackagePin = mcp.kyoso.args[1].slice("--package=".length);
    const canonicalSnapshot = await directorySnapshot(canonical);

    expect(await hashSkillDirectory(canonical)).toBe(CURRENT_SKILL_DIGEST);
    expect(await hashSkillDirectory(plugin)).not.toBe(CURRENT_SKILL_DIGEST);
    expect(canonicalMetadata).not.toContain("dependencies:");
    expect(
      pluginMetadata.startsWith(`${canonicalMetadata.trimEnd()}\n\n`),
    ).toBe(true);
    expect(pluginMetadata).toContain("dependencies:");
    expect(pluginMetadata).toContain('type: "mcp"');
    expect(pluginMetadata).toContain('value: "kyoso"');
    expect(pluginMetadata).toContain('transport: "stdio"');
    expect(canonicalInstructions).toContain(
      "`npx -y --package=@kyo-so/cli kyoso`",
    );
    expect(canonicalInstructions).toContain(
      "`bunx --package @kyo-so/cli kyoso`",
    );
    expect(canonicalInstructions).not.toContain(cliPackagePin);
    expect(pluginInstructions).toContain(
      `\`npx -y --package=${cliPackagePin} kyoso\``,
    );
    expect(pluginInstructions).toContain(
      `\`bunx --package ${cliPackagePin} kyoso\``,
    );
    expect(await directorySnapshot(plugin)).toEqual({
      ...canonicalSnapshot,
      "SKILL.md": pluginInstructions,
      "agents/openai.yaml": pluginMetadata,
    });
  });

  test("records both probed Codex CLI versions and the minimum version", async () => {
    const mcp = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
    );
    const compatibility = await readJson(
      join(root, "docs", "compatibility", "codex-plugin-runtime.json"),
    );
    const envVars = mcp.kyoso.env_vars;

    expect(compatibility.minimumSupportedCodexVersion).toBe("0.144.0-alpha.4");
    expect(
      compatibility.probes.map(
        (probe: { codexVersion: string }) => probe.codexVersion,
      ),
    ).toEqual(["0.144.0-alpha.4", "0.144.1"]);
    expect(compatibility.expectedContract).toMatchObject({
      marketplace: { pluginId: "kyoso@kyoso" },
      environment: {
        cwdIsWorkspace: true,
        deniedSentinelForwarded: false,
      },
    });
    expect(compatibility.expectedContract.mcp.default.envVars).toEqual(envVars);
    expect(compatibility.expectedContract.mcp.pluginOverride.envVars).toEqual(
      envVars,
    );
    expect(compatibility.expectedContract.appServer.pluginOverride).toEqual({
      serverFound: true,
      toolNames: [],
      authStatus: "unsupported",
      skillFound: false,
      skillEnabled: null,
      skillHasKyosoMcpDependency: false,
      mcpObservationWritten: false,
    });
    expect(compatibility.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fixtureSchemaVersion: 2 }),
      ]),
    );
  });

  test("keeps the bundled runtime contract structurally synchronized with its record", async () => {
    const compatibility = await readJson(
      join(root, "docs", "compatibility", "codex-plugin-runtime.json"),
    );

    expect(PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION).toBe(
      compatibility.schemaVersion,
    );
    expect(MINIMUM_SUPPORTED_CODEX_VERSION).toBe(
      compatibility.minimumSupportedCodexVersion,
    );
    expect(PLUGIN_RUNTIME_EXPECTED_CONTRACT).toEqual(
      compatibility.expectedContract,
    );
  });

  test("bounds every runtime probe command by one version-wide deadline", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import {
            boundedProbeTimeoutMs,
            remainingProbeTimeoutMs,
          } from "./scripts/plugin-runtime-deadline.mjs";

          if (boundedProbeTimeoutMs(1_000, 600, 100) !== 600) {
            throw new Error("requested timeout was not preserved");
          }
          if (boundedProbeTimeoutMs(1_000, 600, 700) !== 300) {
            throw new Error("timeout was not capped by the probe deadline");
          }
          if (remainingProbeTimeoutMs(1_000, 2_000, 700) !== 300) {
            throw new Error("cleanup timeout was not capped by the probe deadline");
          }
          if (remainingProbeTimeoutMs(1_000, 2_000, 1_000) !== 0) {
            throw new Error("expired cleanup timeout was not zero");
          }
          try {
            boundedProbeTimeoutMs(1_000, 600, 1_000);
            throw new Error("expired deadline was accepted");
          } catch (error) {
            if (!String(error).includes("wall-time deadline")) throw error;
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("stops missing observation polling at the shared deadline", () => {
    const startedAt = Date.now();
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { waitForFileUntilDeadline } from "./scripts/plugin-runtime-deadline.mjs";

          try {
            await waitForFileUntilDeadline(
              "/private/tmp/kyoso-plugin-runtime-missing-" + process.pid,
              Date.now() + 50,
              {
                pollIntervalMs: 10,
                timeoutMessage: "expected observation timeout",
              },
            );
            throw new Error("missing observation was accepted");
          } catch (error) {
            if (!String(error).includes("expected observation timeout")) {
              throw error;
            }
          }
        `,
      ],
      { cwd: root, encoding: "utf8", timeout: 2_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("rejects an observation created after the shared deadline", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { writeFileSync, unlinkSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { waitForFileUntilDeadline } from "./scripts/plugin-runtime-deadline.mjs";

          const path = join(tmpdir(), "kyoso-plugin-runtime-late-" + process.pid);
          const wait = waitForFileUntilDeadline(path, Date.now() + 20, {
            pollIntervalMs: 100,
            timeoutMessage: "expected late observation timeout",
          });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
          writeFileSync(path, "late", "utf8");
          let rejected = false;
          try {
            await wait;
          } catch (error) {
            if (!String(error).includes("expected late observation timeout")) {
              throw error;
            }
            rejected = true;
          } finally {
            unlinkSync(path);
          }
          if (!rejected) throw new Error("late observation was accepted");
        `,
      ],
      { cwd: root, encoding: "utf8", timeout: 2_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("keeps the Plugin Skill mirror checkable through plugin:sync", () => {
    const result = spawnSync("node", ["scripts/plugin-sync.mjs", "--check"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("plugin skill mirror is synchronized");
  });

  test("applies the Plugin Skill metadata transform idempotently", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { syncPluginSkill } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-sync-idempotent-"));
          try {
            const skills = join(fixture, ".agents", "skills");
            mkdirSync(skills, { recursive: true });
            cpSync(".agents/skills/kyoso-review", join(skills, "kyoso-review"), { recursive: true });
            mkdirSync(join(fixture, "plugins", "kyoso", ".codex-plugin"), { recursive: true });
            cpSync(
              "plugins/kyoso/.codex-plugin/mcp.json",
              join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
            );
            const first = syncPluginSkill(fixture);
            const metadataPath = join(fixture, "plugins", "kyoso", "skills", "kyoso-review", "agents", "openai.yaml");
            const firstMetadata = readFileSync(metadataPath, "utf8");
            const second = syncPluginSkill(fixture);
            if (
              first.canonicalDigest !== second.canonicalDigest ||
              first.pluginDigest !== second.pluginDigest ||
              firstMetadata !== readFileSync(metadataPath, "utf8")
            ) {
              throw new Error("Plugin Skill sync is not idempotent");
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("rejects a hand-edited Plugin Skill mirror", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { assertPluginSkillMirror } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-mirror-"));
          try {
            cpSync(".agents/skills", join(fixture, ".agents", "skills"), { recursive: true });
            cpSync("plugins/kyoso/skills", join(fixture, "plugins", "kyoso", "skills"), { recursive: true });
            mkdirSync(join(fixture, "plugins", "kyoso", ".codex-plugin"), { recursive: true });
            cpSync(
              "plugins/kyoso/.codex-plugin/mcp.json",
              join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
            );
            const metadataPath = join(fixture, "plugins", "kyoso", "skills", "kyoso-review", "agents", "openai.yaml");
            writeFileSync(
              metadataPath,
              readFileSync(metadataPath, "utf8").replace('value: "kyoso"', 'value: "other"'),
            );
            assertPluginSkillMirror(fixture);
            process.exitCode = 1;
          } catch (error) {
            if (!String(error).includes("Plugin Skill mirror differs from transformed canonical Skill")) {
              throw error;
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("restores the prior Plugin mirror when post-install verification fails", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { syncPluginSkill } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-sync-rollback-"));
          try {
            const canonical = join(fixture, ".agents", "skills", "kyoso-review");
            const mirror = join(fixture, "plugins", "kyoso", "skills", "kyoso-review");
            cpSync(".agents/skills/kyoso-review", canonical, { recursive: true });
            cpSync("plugins/kyoso/skills/kyoso-review", mirror, { recursive: true });
            mkdirSync(join(fixture, "plugins", "kyoso", ".codex-plugin"), { recursive: true });
            cpSync(
              "plugins/kyoso/.codex-plugin/mcp.json",
              join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
            );
            writeFileSync(join(mirror, "SKILL.md"), "previous mirror");
            try {
              syncPluginSkill(fixture, {
                afterInstall: ({ canonicalSkill }) => {
                  writeFileSync(
                    join(canonicalSkill, "agents", "openai.yaml"),
                    "changed during sync",
                  );
                },
              });
              process.exitCode = 1;
            } catch (error) {
              if (!String(error).includes("Plugin Skill mirror differs from transformed canonical Skill")) {
                throw error;
              }
            }
            if (readFileSync(join(mirror, "SKILL.md"), "utf8") !== "previous mirror") {
              throw new Error("prior Plugin mirror was not restored");
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("verifies the complete tracked Plugin distribution without packing", () => {
    const result = spawnSync(
      "node",
      ["scripts/verify-plugin.mjs", "--skip-pack"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("plugin verify ok: kyoso@kyoso");
  });

  test("rejects package script drift for runtime and release verification", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-script-drift-"));
          try {
            cpSync(".agents", join(fixture, ".agents"), { recursive: true });
            cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
            cpSync("plugins", join(fixture, "plugins"), { recursive: true });
            cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
            mkdirSync(join(fixture, "src", "cli"), { recursive: true });
            cpSync("package.json", join(fixture, "package.json"));
            cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
            cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
            const packagePath = join(fixture, "package.json");
            const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
            for (const name of [
              "plugin:runtime:migrate",
              "plugin:verify:registry",
              "plugin:verify:published-cli",
              "plugin:runtime:verify",
            ]) {
              const original = packageMetadata.scripts[name];
              packageMetadata.scripts[name] = "node scripts/other.mjs";
              writeFileSync(packagePath, JSON.stringify(packageMetadata));
              let message = "";
              try {
                verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
              } catch (error) {
                message = String(error);
              }
              if (!message.includes(name + " must exactly equal")) {
                throw new Error(name + " drift was not rejected: " + message);
              }
              packageMetadata.scripts[name] = original;
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("rejects Plugin promotion workflow drift", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const scenarios = [
            {
              name: "missing runner smoke path",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace('      - "scripts/mcp-smoke.mjs"\\n', "");
              },
              expected: "pull_request.paths must contain canonical paths exactly once",
            },
            {
              name: "broad promotion workflow path",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - "plugins/**"\\n',
                  '      - "plugins/**"\\n      - "**"\\n',
                );
              },
              expected: "pull_request.paths must contain canonical paths exactly once",
            },
            {
              name: "commented package path",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - "plugins/**"',
                  '      - "plugins/**"\\n      - "package.json" # re-added',
                );
              },
              expected: "pull_request.paths must contain canonical paths exactly once",
            },
            {
              name: "inert safe-chain verification",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: npx safe-chain-verify",
                  '        run: echo "npx safe-chain-verify"',
                );
              },
              expected: "must run npx safe-chain-verify before published CLI smoke exactly once",
            },
            {
              name: "job-level inert run mapping",
              mutate({ workflow }) {
                workflow.value = workflow.value
                  .replace(
                    "  verify-plugin-promotion:\\n",
                    "  verify-plugin-promotion:\\n    env:\\n      run: bun run plugin:verify:published-cli\\n",
                  )
                  .replace(
                    "        run: bun run plugin:verify:published-cli",
                    '        run: echo "bun run plugin:verify:published-cli"',
                  );
              },
              expected: "must run published CLI smoke before recorded Codex Plugin probes exactly once",
            },
            {
              name: "conditional published smoke",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      - name: Verify published CLI runtime\\n        run: bun run plugin:verify:published-cli",
                  "      - name: Verify published CLI runtime\\n        if: false\\n        run: bun run plugin:verify:published-cli",
                );
              },
              expected: "must run published CLI smoke before recorded Codex Plugin probes without if, continue-on-error, or shell",
            },
            {
              name: "conditional promotion job",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    runs-on: ubuntu-latest",
                  "    if: false\\n    runs-on: ubuntu-latest",
                );
              },
              expected: "job must not use if or continue-on-error",
            },
            {
              name: "continue-on-error promotion job",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    runs-on: ubuntu-latest",
                  "    continue-on-error: true\\n    runs-on: ubuntu-latest",
                );
              },
              expected: "job must not use if or continue-on-error",
            },
            {
              name: "post-steps quoted continue-on-error promotion job",
              mutate({ workflow }) {
                workflow.value += '    "continue-on-error": true\\n';
              },
              expected: "job must not use if or continue-on-error",
            },
            {
              name: "workflow defaults",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "permissions:",
                  "defaults:\\n  run:\\n    shell: echo {0}\\n\\npermissions:",
                );
              },
              expected: "must not configure workflow-level defaults",
            },
            {
              name: "required step shell override",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      - name: Verify published CLI runtime\\n        run: bun run plugin:verify:published-cli",
                  "      - name: Verify published CLI runtime\\n        shell: echo {0}\\n        run: bun run plugin:verify:published-cli",
                );
              },
              expected: "must run published CLI smoke before recorded Codex Plugin probes without if, continue-on-error, or shell",
            },
            {
              name: "quoted required step shell override",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      - name: Verify published CLI runtime\\n        run: bun run plugin:verify:published-cli",
                  '      - name: Verify published CLI runtime\\n        "shell": echo {0}\\n        run: bun run plugin:verify:published-cli',
                );
              },
              expected: "must run published CLI smoke before recorded Codex Plugin probes without if, continue-on-error, or shell",
            },
            {
              name: "published smoke after runtime replay",
              mutate({ workflow }) {
                const published = "bun run plugin:verify:published-cli";
                const runtime = "bun run plugin:runtime:verify";
                workflow.value = workflow.value
                  .replace(published, "__published_cli_smoke__")
                  .replace(runtime, published)
                  .replace("__published_cli_smoke__", runtime);
              },
              expected: "must run published CLI smoke before recorded Codex Plugin probes",
            },
          ];

          for (const scenario of scenarios) {
            const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-workflow-"));
            try {
              cpSync(".agents", join(fixture, ".agents"), { recursive: true });
              cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
              cpSync("plugins", join(fixture, "plugins"), { recursive: true });
              cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
              mkdirSync(join(fixture, "src", "cli"), { recursive: true });
              mkdirSync(join(fixture, ".github", "workflows"), { recursive: true });
              cpSync("package.json", join(fixture, "package.json"));
              cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
              cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
              cpSync(
                ".github/workflows/plugin-promotion.yml",
                join(fixture, ".github", "workflows", "plugin-promotion.yml"),
              );
              const workflow = {
                value: readFileSync(
                  join(fixture, ".github", "workflows", "plugin-promotion.yml"),
                  "utf8",
                ),
              };
              scenario.mutate({ workflow });
              writeFileSync(
                join(fixture, ".github", "workflows", "plugin-promotion.yml"),
                workflow.value,
              );
              let message = "";
              try {
                verifyPluginDistribution({
                  root: fixture,
                  verifyPackageArchive: false,
                  verifyPromotionWorkflow: true,
                });
              } catch (error) {
                message = String(error);
              }
              if (!message.includes(scenario.expected)) {
                throw new Error(scenario.name + " did not report " + scenario.expected + ": " + message);
              }
            } finally {
              rmSync(fixture, { force: true, recursive: true });
            }
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("rejects a reintroduced Plugin-root .mcp.json", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-root-mcp-"));
          try {
            cpSync(".agents", join(fixture, ".agents"), { recursive: true });
            cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
            cpSync("plugins", join(fixture, "plugins"), { recursive: true });
            cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
            mkdirSync(join(fixture, "src", "cli"), { recursive: true });
            cpSync("package.json", join(fixture, "package.json"));
            cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
            cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
            writeFileSync(join(fixture, "plugins", "kyoso", ".mcp.json"), "{}");
            try {
              verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
              process.exitCode = 1;
            } catch (error) {
              if (!String(error).includes("Plugin root must not contain .mcp.json")) {
                throw error;
              }
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("rejects Claude manifest drift and non-inline MCP definitions", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const scenarios = [
            {
              name: "stale Claude version",
              mutate(manifest) {
                manifest.version = "0.1.0";
              },
              expected: [
                "plugins/kyoso/.claude-plugin/plugin.json version",
                "0.1.0",
              ],
            },
            {
              name: "different Claude pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=@kyo-so/cli@0.9.0";
              },
              expected: [
                "Claude plugin MCP package pin",
                "@kyo-so/cli@0.9.0",
              ],
            },
            {
              name: "non-SemVer Claude pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=@kyo-so/cli@latest";
              },
              expected: [
                "Claude plugin MCP package pin must be an exact @kyo-so/cli SemVer",
              ],
            },
            {
              name: "ambiguous positional Claude command",
              mutate(manifest) {
                const pin = manifest.mcpServers.kyoso.args[1].slice("--package=".length);
                manifest.mcpServers.kyoso.args = ["-y", pin, "mcp"];
              },
              expected: [
                'Claude plugin MCP args must be ["-y", "--package=@kyo-so/cli@VERSION", "kyoso", "mcp"]',
              ],
            },
            {
              name: "wrong Claude executable",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[2] = "other";
              },
              expected: [
                "Claude plugin MCP args must exactly equal",
                '"other"',
              ],
            },
            {
              name: "missing Claude package flag",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "@kyo-so/cli@0.13.1";
              },
              expected: [
                "Claude plugin MCP package pin must be an exact @kyo-so/cli SemVer",
                "args[1] was",
              ],
            },
            {
              name: "extra Claude argument",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args.push("--verbose");
              },
              expected: [
                "Claude plugin MCP args must exactly equal",
                '"--verbose"',
              ],
            },
            {
              name: "tagged Claude package pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=@kyo-so/cli@latest";
              },
              expected: [
                "Claude plugin MCP package pin must be an exact @kyo-so/cli SemVer",
              ],
            },
            {
              name: "ranged Claude package pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=@kyo-so/cli@^0.13.1";
              },
              expected: [
                "Claude plugin MCP package pin must be an exact @kyo-so/cli SemVer",
              ],
            },
            {
              name: "path-based Claude MCP definition",
              mutate(manifest) {
                manifest.mcpServers = "./.codex-plugin/mcp.json";
              },
              expected: [
                "Claude plugin manifest mcpServers must be an inline object",
              ],
            },
            {
              name: "unsupported Claude manifest fields",
              mutate(manifest) {
                manifest.interface = {};
                manifest.hooks = {};
                manifest.commands = "./commands";
                manifest.mcpServers.kyoso.env_vars = [];
              },
              expected: [
                "Claude plugin manifest has unsupported key: interface",
                "Claude plugin manifest has unsupported key: hooks",
                "Claude plugin manifest has unsupported key: commands",
                "Claude plugin manifest mcpServers.kyoso has unsupported key: env_vars",
              ],
            },
            {
              name: "unsupported Claude MCP environment variable",
              mutate(manifest) {
                manifest.mcpServers.kyoso.env = {
                  PATH: "$" + "{PATH}",
                };
              },
              expected: [
                "Claude plugin MCP env has unsupported variable: PATH",
              ],
            },
            {
              name: "missing Claude OAuth passthrough",
              mutate(manifest) {
                delete manifest.mcpServers.kyoso.env.CLAUDE_CODE_OAUTH_TOKEN;
              },
              expected: [
                "Claude plugin MCP env must match the optional credential placeholders exactly",
              ],
            },
            {
              name: "literal Claude MCP credential",
              mutate(manifest) {
                manifest.mcpServers.kyoso.env.OPENROUTER_API_KEY = "literal";
              },
              expected: [
                "Claude plugin MCP env OPENROUTER_API_KEY must forward",
              ],
            },
          ];

          for (const scenario of scenarios) {
            const fixture = mkdtempSync(join(tmpdir(), "kyoso-claude-plugin-"));
            try {
              cpSync(".agents", join(fixture, ".agents"), { recursive: true });
              cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
              cpSync("plugins", join(fixture, "plugins"), { recursive: true });
              cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
              mkdirSync(join(fixture, "src", "cli"), { recursive: true });
              cpSync("package.json", join(fixture, "package.json"));
              cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
              cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
              const manifestPath = join(fixture, "plugins", "kyoso", ".claude-plugin", "plugin.json");
              const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
              scenario.mutate(manifest);
              writeFileSync(manifestPath, JSON.stringify(manifest));
              let message = "";
              try {
                verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
              } catch (error) {
                message = String(error);
              }
              if (!message) {
                throw new Error(scenario.name + " unexpectedly passed verification");
              }
              for (const expected of scenario.expected) {
                if (!message.includes(expected)) {
                  throw new Error(scenario.name + " did not report " + expected + ": " + message);
                }
              }
            } finally {
              rmSync(fixture, { force: true, recursive: true });
            }
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("rejects noncanonical Codex MCP argv and a missing primary executable", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const scenarios = [
            {
              name: "legacy positional argv",
              mutate({ mcp }) {
                mcp.kyoso.args = ["-y", "@kyo-so/cli@0.13.1", "mcp"];
              },
              expected: ["Plugin MCP package pin must be an exact @kyo-so/cli SemVer"],
            },
            {
              name: "wrong executable",
              mutate({ mcp }) {
                mcp.kyoso.args[2] = "other";
              },
              expected: ["Plugin MCP args must exactly equal", '"other"'],
            },
            {
              name: "missing primary executable",
              mutate({ packageMetadata }) {
                delete packageMetadata.bin.kyoso;
              },
              expected: ['package.json bin.kyoso must equal "dist/bin/kyoso.js"'],
            },
          ];

          for (const scenario of scenarios) {
            const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-mcp-contract-"));
            try {
              cpSync(".agents", join(fixture, ".agents"), { recursive: true });
              cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
              cpSync("plugins", join(fixture, "plugins"), { recursive: true });
              cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
              mkdirSync(join(fixture, "src", "cli"), { recursive: true });
              cpSync("package.json", join(fixture, "package.json"));
              cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
              cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
              const mcpPath = join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json");
              const packagePath = join(fixture, "package.json");
              const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
              const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
              scenario.mutate({ mcp, packageMetadata });
              writeFileSync(mcpPath, JSON.stringify(mcp));
              writeFileSync(packagePath, JSON.stringify(packageMetadata));
              let message = "";
              try {
                verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
              } catch (error) {
                message = String(error);
              }
              if (!message) throw new Error(scenario.name + " unexpectedly passed verification");
              for (const expected of scenario.expected) {
                if (!message.includes(expected)) {
                  throw new Error(scenario.name + " did not report " + expected + ": " + message);
                }
              }
            } finally {
              rmSync(fixture, { force: true, recursive: true });
            }
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("accepts an explicit matching promotion target", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-promotion-match-"));
          try {
            cpSync(".agents", join(fixture, ".agents"), { recursive: true });
            cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
            cpSync("plugins", join(fixture, "plugins"), { recursive: true });
            cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
            mkdirSync(join(fixture, "src", "cli"), { recursive: true });
            cpSync("package.json", join(fixture, "package.json"));
            cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
            cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
            const mcpPath = join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json");
            const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
            const pinArgument = mcp.kyoso.args.find((argument) => argument.startsWith("--package=@kyo-so/cli@"));
            const pinVersion = pinArgument.slice("--package=@kyo-so/cli@".length);
            const packagePath = join(fixture, "package.json");
            const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
            packageMetadata.version = pinVersion;
            writeFileSync(packagePath, JSON.stringify(packageMetadata));
            verifyPluginDistribution({
              root: fixture,
              verifyPackageArchive: false,
              expectedPackageVersion: pinVersion,
            });
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  test("rejects camelCase policy keys and noncanonical MCP paths", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-policy-"));
          try {
            cpSync(".agents", join(fixture, ".agents"), { recursive: true });
            cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
            cpSync("plugins", join(fixture, "plugins"), { recursive: true });
            cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
            mkdirSync(join(fixture, "src", "cli"), { recursive: true });
            cpSync("package.json", join(fixture, "package.json"));
            cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
            cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
            const manifestPath = join(fixture, "plugins", "kyoso", ".codex-plugin", "plugin.json");
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
            manifest.approvalPolicy = "never";
            manifest.sandboxPermissions = "dangerously-bypass";
            manifest.trustLevel = "trusted";
            manifest.sandboxMode = "danger-full-access";
            cpSync(
              join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
              join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp-legacy.json"),
            );
            manifest.mcpServers = "./.codex-plugin/mcp-legacy.json";
            writeFileSync(manifestPath, JSON.stringify(manifest));
            try {
              verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
              process.exitCode = 1;
            } catch (error) {
              if (
                !String(error).includes("approvalPolicy") ||
                !String(error).includes("sandboxPermissions") ||
                !String(error).includes("trustLevel") ||
                !String(error).includes("sandboxMode") ||
                !String(error).includes(
                  "Plugin manifest mcpServers must resolve to ./.codex-plugin/mcp.json",
                )
              ) {
                throw error;
              }
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("allows the pre-promotion pin and requires an explicit target match", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          import { verifyPluginDistribution } from "./scripts/plugin-distribution.mjs";

          const fixture = mkdtempSync(join(tmpdir(), "kyoso-plugin-pre-promotion-"));
          try {
            cpSync(".agents", join(fixture, ".agents"), { recursive: true });
            cpSync(".claude-plugin", join(fixture, ".claude-plugin"), { recursive: true });
            cpSync("plugins", join(fixture, "plugins"), { recursive: true });
            cpSync("docs/compatibility", join(fixture, "docs", "compatibility"), { recursive: true });
            mkdirSync(join(fixture, "src", "cli"), { recursive: true });
            cpSync("package.json", join(fixture, "package.json"));
            cpSync("src/cli/knownSkillDigests.ts", join(fixture, "src", "cli", "knownSkillDigests.ts"));
            cpSync("src/cli/pluginRuntimeContract.ts", join(fixture, "src", "cli", "pluginRuntimeContract.ts"));
            const mcpPath = join(fixture, "plugins", "kyoso", ".codex-plugin", "mcp.json");
            const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
            const pinArgument = mcp.kyoso.args.find((argument) => argument.startsWith("--package=@kyo-so/cli@"));
            const pinVersion = pinArgument.slice("--package=@kyo-so/cli@".length);
            const pinParts = pinVersion.split("-")[0].split(".");
            const aheadVersion = [pinParts[0], pinParts[1], String(Number(pinParts[2]) + 1)].join(".");
            const packagePath = join(fixture, "package.json");
            const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
            packageMetadata.version = aheadVersion;
            writeFileSync(packagePath, JSON.stringify(packageMetadata));
            verifyPluginDistribution({ root: fixture, verifyPackageArchive: false });
            try {
              verifyPluginDistribution({
                root: fixture,
                verifyPackageArchive: false,
                expectedPackageVersion: aheadVersion,
              });
              process.exitCode = 1;
            } catch (error) {
              const message = String(error);
              if (
                !message.includes("must match expected package version " + aheadVersion) ||
                !message.includes("Claude plugin MCP pin")
              ) {
                throw error;
              }
            }
          } finally {
            rmSync(fixture, { force: true, recursive: true });
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("requires the Plugin version to advance without rolling back the CLI pin", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { assertPromotionAdvances, compareSemver } from "./scripts/plugin-promote.mjs";

          const current = { packageVersion: "0.8.0", pluginVersion: "0.1.0" };
          assertPromotionAdvances(current, { cliVersion: "0.9.0", pluginVersion: "0.2.0" });
          assertPromotionAdvances(current, { cliVersion: "0.8.0", pluginVersion: "0.2.0" });
          for (const [options, message] of [
            [{ cliVersion: "0.7.0", pluginVersion: "0.2.0" }, "CLI version"],
            [{ cliVersion: "0.9.0", pluginVersion: "0.1.0" }, "Plugin version"],
            [{ cliVersion: "0.9.0", pluginVersion: "0.0.1" }, "Plugin version"],
          ]) {
            try {
              assertPromotionAdvances(current, options);
              throw new Error("unexpected promotion acceptance");
            } catch (error) {
              if (!String(error).includes(message)) throw error;
            }
          }
          if (compareSemver("0.2.0", "0.2.0-beta.1") <= 0) {
            throw new Error("stable version must sort after prerelease");
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  test("promotes Codex and Claude Plugin artifacts", () => {
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "--eval",
        `
          import { join } from "node:path";
          import { createUpdates } from "./scripts/plugin-promote.mjs";

          const cliVersion = "0.9.1";
          const pluginVersion = "0.3.0";
          const packagePin = "@kyo-so/cli@" + cliVersion;
          const updates = createUpdates(
            { cliVersion, pluginVersion },
            process.cwd(),
          );
          const mcpPath = join(
            "plugins",
            "kyoso",
            ".codex-plugin",
            "mcp.json",
          );
          const skillPath = join("plugins", "kyoso", "skills", "kyoso-review", "SKILL.md");
          const claudeManifestPath = join(
            "plugins",
            "kyoso",
            ".claude-plugin",
            "plugin.json",
          );
          const claudeMarketplacePath = join(
            ".claude-plugin",
            "marketplace.json",
          );
          const mcp = updates.find((entry) => entry.path.endsWith(mcpPath));
          const skill = updates.find((entry) => entry.path.endsWith(skillPath));
          const claudeManifest = updates.find((entry) =>
            entry.path.endsWith(claudeManifestPath),
          );
          const claudeMarketplace = updates.find((entry) =>
            entry.path.endsWith(claudeMarketplacePath),
          );
          if (updates.length !== 7) {
            throw new Error("Plugin promotion must update exactly seven files");
          }
          if (
            !mcp || JSON.parse(mcp.next).kyoso.args[1] !== "--package=" + packagePin
          ) {
            throw new Error("Plugin promotion did not update the relocated MCP pin");
          }
          if (
            !skill?.next.includes("npx -y --package=" + packagePin + " kyoso") ||
            !skill.next.includes("bunx --package " + packagePin + " kyoso")
          ) {
            throw new Error("Plugin promotion did not update both Skill fallback pins");
          }
          if (!claudeManifest || !claudeMarketplace) {
            throw new Error("Plugin promotion did not include both Claude artifacts");
          }
          const nextClaudeManifest = JSON.parse(claudeManifest.next);
          const nextClaudeMarketplace = JSON.parse(claudeMarketplace.next);
          if (
            nextClaudeManifest.version !== pluginVersion ||
            nextClaudeManifest.mcpServers.kyoso.args[1] !== "--package=" + packagePin
          ) {
            throw new Error("Plugin promotion did not update the Claude manifest version and pin");
          }
          if (
            nextClaudeMarketplace.plugins[0].version !== pluginVersion ||
            nextClaudeMarketplace.metadata.version !== pluginVersion
          ) {
            throw new Error("Plugin promotion did not update both Claude marketplace versions");
          }
        `,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });
});

async function directorySnapshot(directory: string, prefix = "") {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(snapshot, await directorySnapshot(path, relativePath));
    } else {
      snapshot[relativePath] = await readFile(path, "utf8");
    }
  }
  return snapshot;
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}
