import { describe, expect, test } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CURRENT_SKILL_DIGEST } from "../../src/cli/knownSkillDigests.js";
import {
  MINIMUM_SUPPORTED_CODEX_VERSION,
  PLUGIN_RUNTIME_COMPATIBILITY_SCHEMA_VERSION,
  PLUGIN_RUNTIME_EXPECTED_CONTRACT,
} from "../../src/cli/pluginRuntimeContract.js";
import { hashSkillDirectory } from "../../src/cli/skillInstall.js";
import { KYOSO_PACKAGE_ALIAS_PREFIX } from "../../src/cli/packageRunner.js";
// @ts-expect-error The distribution verifier is intentionally shipped as a standalone Node.js script.
import { transformCanonicalToPlugin } from "../../scripts/plugin-distribution.mjs";
// @ts-expect-error Same standalone script; kept as its own statement so Prettier cannot move the directive off the import.
import { pluginMcpPackageAliasPrefix } from "../../scripts/plugin-distribution.mjs";

const root = process.cwd();
describe("Codex Plugin fixture", () => {
  // The alias only protects a reader who copies the command, so the documents
  // that publish those commands are part of the contract. `plugin:verify` covers
  // the shipped artifacts; nothing else covered the prose until this test.
  test("keeps every documented package-runner command aliased", async () => {
    // The package can follow `--package` three ways: joined by `=`, separated by
    // a space, or held in the next element of a TOML/JSON array. The design doc
    // and the Codex example both use the array form, so a pattern that only
    // accepts `=` or a space would let exactly those lines regress unseen.
    const packageArgument = (name: string) =>
      new RegExp(`--package(?:[= ]|",\\s*)"?${name}`);
    const unaliased = packageArgument("@kyo-so/cli");
    const aliased = packageArgument("kyoso-cli@npm:@kyo-so/cli");
    const documents = [
      "README.md",
      "README.ja.md",
      "README.zh-CN.md",
      "docs/kyoso_detailed_design.md",
      ".agents/skills/kyoso-review/SKILL.md",
      // Readers copy these verbatim into their own client configuration, so
      // they carry the same contract as the prose.
      "examples/codex-config.toml",
      "examples/claude-code-mcp.json",
    ];
    // The CHANGELOG quotes commands only when a release changes one, so it must
    // never publish an unaliased form but cannot be required to hold an aliased
    // one.
    const unaliasedOnly = ["CHANGELOG.md"];
    const offenders: string[] = [];
    const empty: string[] = [];
    for (const relative of [...documents, ...unaliasedOnly]) {
      const content = await readFile(join(root, relative), "utf8");
      for (const [index, line] of content.split("\n").entries()) {
        if (unaliased.test(line)) offenders.push(`${relative}:${index + 1}`);
      }
      // A JSON or TOML array can break between `--package` and the package, so
      // the per-line scan above cannot see that form at all. Scanning the whole
      // document catches it; the line loop stays because it reports where.
      if (
        unaliased.test(content) &&
        !offenders.some((at) => at.startsWith(`${relative}:`))
      ) {
        offenders.push(`${relative}:(spans lines)`);
      }
      // Without this, deleting every command from a document would satisfy the
      // check above rather than fail it.
      if (documents.includes(relative) && !aliased.test(content)) {
        empty.push(relative);
      }
    }

    expect(offenders).toEqual([]);
    expect(empty).toEqual([]);

    // The CLI writes registrations and the distribution verifier checks them,
    // but each holds its own copy of the prefix because one is TypeScript and
    // the other a standalone Node.js script. Renaming only one would make the
    // verifier reject every registration `kyoso setup` produces.
    expect(KYOSO_PACKAGE_ALIAS_PREFIX).toBe(pluginMcpPackageAliasPrefix);
    expect(
      aliased.test(`--package=${KYOSO_PACKAGE_ALIAS_PREFIX}@kyo-so/cli`),
    ).toBe(true);
  });

  test("uses the fixed marketplace, plugin, and MCP identities", async () => {
    const packageMetadata = await readJson(join(root, "package.json"));
    const marketplace = await readJson(
      join(root, ".agents", "plugins", "marketplace.json"),
    );
    const manifest = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "plugin.json"),
    );
    const icon = join(root, "plugins", "kyoso", "assets", "kyoso-icon.png");
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
      interface: {
        capabilities: ["Read"],
        composerIcon: "./assets/kyoso-icon.png",
        logo: "./assets/kyoso-icon.png",
      },
    });
    expect(mcp).toEqual({
      kyoso: {
        command: "npx",
        args: [
          "-y",
          `--package=kyoso-cli@npm:${distribution.mcpPackagePin}`,
          "kyoso",
          "mcp",
        ],
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
      `--package=kyoso-cli@npm:${distribution.mcpPackagePin}`,
      "kyoso",
      "mcp",
    ]);
    expect(packageMetadata.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageMetadata.bin).toMatchObject({ kyoso: "dist/bin/kyoso.js" });
    expect(distribution.mcpExecutable).toBe("kyoso");
    expect((await stat(icon)).isFile()).toBe(true);
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
    const cliPackagePin = mcp.kyoso.args[1].slice(
      "--package=kyoso-cli@npm:".length,
    );
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
      "`npx -y --package=kyoso-cli@npm:@kyo-so/cli kyoso`",
    );
    expect(canonicalInstructions).toContain(
      "`bunx --package kyoso-cli@npm:@kyo-so/cli kyoso`",
    );
    expect(canonicalInstructions).not.toContain(cliPackagePin);
    expect(canonicalInstructions).toContain(
      "`--set agents.<agent>.timeoutS=<seconds>`",
    );
    expect(pluginInstructions).toContain(
      `\`npx -y --package=kyoso-cli@npm:${cliPackagePin} kyoso\``,
    );
    expect(pluginInstructions).toContain(
      `\`bunx --package kyoso-cli@npm:${cliPackagePin} kyoso\``,
    );
    expect(pluginInstructions).toContain(
      "`--set agents.<agent>.timeoutS=<seconds>`",
    );
    expect(pluginInstructions).not.toContain(
      "`--set agents.<agent>.timeoutMs=<ms>`",
    );
    const legacyInstructions = transformCanonicalToPlugin(
      "SKILL.md",
      Buffer.from(canonicalInstructions),
      "@kyo-so/cli@0.15.2",
    ).toString("utf8");
    expect(legacyInstructions).toContain(
      "`--set agents.<agent>.timeoutMs=<ms>`",
    );
    expect(legacyInstructions).not.toContain(
      "`--set agents.<agent>.timeoutS=<seconds>`",
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
              "plugin:promotion:reconcile",
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

  test("creates identifiable promotion reminders from the default branch", async () => {
    const workflow = await readFile(
      join(root, ".github", "workflows", "release.yml"),
      "utf8",
    );
    const reminderStart = workflow.indexOf("  promotion-reminder:");
    expect(reminderStart).toBeGreaterThan(-1);
    const reminder = workflow.slice(reminderStart);

    expect(reminder).toContain("    continue-on-error: true");
    expect(reminder).toContain("        id: promotion_reminder");
    expect(reminder).toContain(
      "        continue-on-error: true\n        env:\n          GH_TOKEN:",
    );
    expect(reminder).toContain(
      "          ref: ${{ github.event.repository.default_branch }}",
    );
    expect(reminder).toContain(
      '"<!-- kyoso:plugin-promotion-reminder cli=${RELEASE_VERSION} -->"',
    );
    // The workflow extracts the pin with its own copy of the alias prefix, so a
    // rename that missed it would silently read no pin at all.
    expect(workflow).toContain("--package=kyoso-cli@npm:@kyo-so/cli@");
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
              name: "missing push branch",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    branches:\\n      - main\\n",
                  "",
                );
              },
              expected: "push.branches must contain main exactly once",
            },
            {
              name: "non-main push branch",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      - main\\n    paths:",
                  "      - release\\n    paths:",
                );
              },
              expected: "push.branches must contain main exactly once",
            },
            {
              name: "duplicate push branch",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      - main\\n    paths:",
                  "      - main\\n      - main\\n    paths:",
                );
              },
              expected: "push.branches must contain main exactly once",
            },
            {
              name: "missing push artifact",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - ".claude-plugin/marketplace.json"\\n',
                  "",
                );
              },
              expected: "push.paths must contain promotion artifacts exactly once",
            },
            {
              name: "extra push artifact",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - ".claude-plugin/marketplace.json"\\n',
                  '      - ".claude-plugin/marketplace.json"\\n      - "package.json"\\n',
                );
              },
              expected: "push.paths must contain promotion artifacts exactly once",
            },
            {
              name: "duplicate push artifact",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - ".claude-plugin/marketplace.json"\\n',
                  '      - ".claude-plugin/marketplace.json"\\n      - ".claude-plugin/marketplace.json"\\n',
                );
              },
              expected: "push.paths must contain promotion artifacts exactly once",
            },
            {
              name: "broad push artifact",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  '      - ".claude-plugin/marketplace.json"\\n',
                  '      - ".claude-plugin/marketplace.json"\\n      - "plugins/**"\\n',
                );
              },
              expected: "push.paths must contain promotion artifacts exactly once",
            },
            {
              name: "extra push trigger key",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "  pull_request:\\n",
                  "    tags:\\n      - v*\\n  pull_request:\\n",
                );
              },
              expected: "push must define only branches and paths",
            },
            {
              name: "inline extra push trigger key",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    paths:\\n",
                  '    tags: ["v*"]\\n    paths:\\n',
                );
              },
              expected: "push must define only branches and paths",
            },
            {
              name: "missing close job",
              mutate({ workflow }) {
                workflow.value = workflow.value.slice(
                  0,
                  workflow.value.indexOf("  close-promotion-reminders:"),
                );
              },
              expected: "must define close-promotion-reminders exactly once",
            },
            {
              name: "duplicate close job",
              mutate({ workflow }) {
                const closeJob = workflow.value.slice(
                  workflow.value.indexOf("  close-promotion-reminders:"),
                );
                workflow.value += "\\n" + closeJob;
              },
              expected: "must define close-promotion-reminders exactly once",
            },
            {
              name: "wrong close dependency",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    needs: verify-plugin-promotion\\n    if: >-",
                  "    needs: other-job\\n    if: >-",
                );
              },
              expected: "close job needs must equal verify-plugin-promotion",
            },
            {
              name: "pull request close condition",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "github.event_name == 'push'",
                  "github.event_name == 'pull_request'",
                );
              },
              expected: "close job if must allow only main push or main workflow_dispatch",
            },
            {
              name: "non-main close condition",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "refs/heads/main",
                  "refs/heads/release",
                );
              },
              expected: "close job if must allow only main push or main workflow_dispatch",
            },
            {
              name: "missing issue permission",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      issues: write\\n    steps:",
                  "    steps:",
                );
              },
              expected: "permissions must contain only contents read and issues write",
            },
            {
              name: "extra close permission",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      issues: write\\n    steps:",
                  "      issues: write\\n      actions: write\\n    steps:",
                );
              },
              expected: "permissions must contain only contents read and issues write",
            },
            {
              name: "missing reconciliation command",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        run: node scripts/other.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation exactly once",
            },
            {
              name: "duplicate reconciliation command",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        run: node scripts/plugin-promotion-issues.mjs\\n\\n      - name: Duplicate reconciliation\\n        run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation exactly once",
            },
            {
              name: "inert reconciliation env run",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "          run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation exactly once",
            },
            {
              name: "conditional reconciliation",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        if: false\\n        run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation without if, continue-on-error, or shell",
            },
            {
              name: "best-effort reconciliation",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        continue-on-error: true\\n        run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation without if, continue-on-error, or shell",
            },
            {
              name: "reconciliation shell override",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        shell: echo {0}\\n        run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation without if, continue-on-error, or shell",
            },
            {
              name: "reconciliation working directory",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: node scripts/plugin-promotion-issues.mjs",
                  "        working-directory: other\\n        run: node scripts/plugin-promotion-issues.mjs",
                );
              },
              expected: "must run promotion reminder reconciliation without working-directory",
            },
            {
              name: "close job continue on error",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "  close-promotion-reminders:\\n    needs:",
                  "  close-promotion-reminders:\\n    continue-on-error: true\\n    needs:",
                );
              },
              expected: "close job must not use continue-on-error",
            },
            {
              name: "close job defaults",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "      issues: write\\n    steps:",
                  "      issues: write\\n    defaults:\\n      run:\\n        working-directory: other\\n    steps:",
                );
              },
              expected: "close job must not configure defaults",
            },
            {
              name: "close job container",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "    runs-on: ubuntu-latest\\n    permissions:\\n      contents: read\\n      issues: write",
                  "    runs-on: ubuntu-latest\\n    container: attacker/image\\n    permissions:\\n      contents: read\\n      issues: write",
                );
              },
              expected: "close job must not configure a container",
            },
            {
              name: "close job extra step",
              mutate({ workflow }) {
                workflow.value +=
                  "\\n      - name: Extra issue writer\\n        run: gh issue close 1\\n";
              },
              expected: "close job steps must be checkout, Node 24 setup, and reconciliation only",
            },
            {
              name: "inert safe-chain verification",
              mutate({ workflow }) {
                workflow.value = workflow.value.replace(
                  "        run: npx safe-chain-verify",
                  '        run: echo "npx safe-chain-verify"',
                );
              },
              expected: "must run npx safe-chain verification exactly once",
            },
            {
              name: "published smoke after safe-chain setup",
              mutate({ workflow }) {
                const published =
                  "      - name: Verify published CLI runtime\\n        run: bun run plugin:verify:published-cli\\n\\n";
                workflow.value = workflow.value.replace(published, "");
                workflow.value = workflow.value.replace(
                  "      - name: Setup safe-chain shims\\n        run: safe-chain setup-ci",
                  "      - name: Setup safe-chain shims\\n        run: safe-chain setup-ci\\n\\n" +
                    published.trimEnd(),
                );
              },
              expected:
                "must run published CLI smoke before safe-chain setup",
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
                workflow.value = workflow.value.replace(
                  "\\n  close-promotion-reminders:",
                  '\\n    "continue-on-error": true\\n\\n  close-promotion-reminders:',
                );
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
                manifest.mcpServers.kyoso.args[1] = "--package=kyoso-cli@npm:@kyo-so/cli@0.9.0";
              },
              expected: [
                "Claude plugin MCP package pin",
                "@kyo-so/cli@0.9.0",
              ],
            },
            {
              name: "non-SemVer Claude pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=kyoso-cli@npm:@kyo-so/cli@latest";
              },
              expected: [
                "Claude plugin MCP package pin must pin an exact @kyo-so/cli SemVer (invariant I3)",
              ],
            },
            {
              name: "ambiguous positional Claude command",
              mutate(manifest) {
                const pin = manifest.mcpServers.kyoso.args[1].slice("--package=kyoso-cli@npm:".length);
                manifest.mcpServers.kyoso.args = ["-y", pin, "mcp"];
              },
              expected: [
                'Claude plugin MCP args must be ["-y", "--package=kyoso-cli@npm:@kyo-so/cli@VERSION", "kyoso", "mcp"]',
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
                "Claude plugin MCP package pin must be selected by an --package= argument at args[1]",
                "args[1] was",
              ],
            },
            {
              name: "unaliased Claude package pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = manifest.mcpServers.kyoso.args[1].replace("kyoso-cli@npm:", "");
              },
              expected: [
                "Claude plugin MCP package pin must carry the kyoso-cli@npm: npm alias (invariant I4)",
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
                manifest.mcpServers.kyoso.args[1] = "--package=kyoso-cli@npm:@kyo-so/cli@latest";
              },
              expected: [
                "Claude plugin MCP package pin must pin an exact @kyo-so/cli SemVer (invariant I3)",
              ],
            },
            {
              name: "ranged Claude package pin",
              mutate(manifest) {
                manifest.mcpServers.kyoso.args[1] = "--package=kyoso-cli@npm:@kyo-so/cli@^0.13.1";
              },
              expected: [
                "Claude plugin MCP package pin must pin an exact @kyo-so/cli SemVer (invariant I3)",
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
              expected: ["Plugin MCP package pin must be selected by an --package= argument at args[1]"],
            },
            {
              name: "unaliased Codex package pin",
              mutate({ mcp }) {
                mcp.kyoso.args[1] = mcp.kyoso.args[1].replace("kyoso-cli@npm:", "");
              },
              expected: ["Plugin MCP package pin must carry the kyoso-cli@npm: npm alias (invariant I4)"],
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
            const pinArgument = mcp.kyoso.args.find((argument) => argument.startsWith("--package=kyoso-cli@npm:@kyo-so/cli@"));
            const pinVersion = pinArgument.slice("--package=kyoso-cli@npm:@kyo-so/cli@".length);
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

  test("rejects unsafe manifest keys and noncanonical Plugin paths", () => {
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
            manifest.interface.composerIcon = "./.codex-plugin/mcp.json";
            manifest.interface.logo = "./.codex-plugin/mcp.json";
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
                  "Plugin manifest interface.composerIcon must resolve to ./assets/kyoso-icon.png",
                ) ||
                !String(error).includes(
                  "Plugin manifest interface.logo must resolve to ./assets/kyoso-icon.png",
                ) ||
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
            const pinArgument = mcp.kyoso.args.find((argument) => argument.startsWith("--package=kyoso-cli@npm:@kyo-so/cli@"));
            const pinVersion = pinArgument.slice("--package=kyoso-cli@npm:@kyo-so/cli@".length);
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
            !mcp || JSON.parse(mcp.next).kyoso.args[1] !== "--package=kyoso-cli@npm:" + packagePin
          ) {
            throw new Error("Plugin promotion did not update the relocated MCP pin");
          }
          if (
            !skill?.next.includes("npx -y --package=kyoso-cli@npm:" + packagePin + " kyoso") ||
            !skill.next.includes("bunx --package kyoso-cli@npm:" + packagePin + " kyoso")
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
            nextClaudeManifest.mcpServers.kyoso.args[1] !== "--package=kyoso-cli@npm:" + packagePin
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
