import { describe, expect, test } from "bun:test";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexPluginInspection } from "../../src/cli/codexPluginDetector.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { detectCli } from "../../src/cli/integration.js";
import {
  CURRENT_SKILL_DIGEST,
  knownSkillDigest,
} from "../../src/cli/knownSkillDigests.js";
import { runSetup } from "../../src/cli/setup.js";
import { hashSkillDirectory } from "../../src/cli/skillInstall.js";

const repositoryRoot = process.cwd();
const pluginUnsupported: CodexPluginInspection = {
  status: "unsupported",
  failure: { operation: "plugin_list", reason: "unavailable" },
};

describe("doctor integration modes", () => {
  for (const client of ["codex", "claude-code"] as const) {
    test.each([
      ["manual MCP and Skill", "manual-mcp", { mcp: true, skill: true }],
      ["installed CLI and Skill", "cli-skill", { cli: true, skill: true }],
      ["Skill and npx", "skill-on-demand", { npx: true, skill: true }],
      ["manual MCP only", "mcp-only", { mcp: true }],
      ["installed CLI only", "cli-only", { cli: true }],
      ["no installation", "missing", {}],
    ] as const)(
      `for ${client}, classifies %s as %s`,
      async (_, expectedMode, fixture) => {
        const context = await doctorFixture();
        await applyIntegrationFixture(context, client, fixture);

        const output = await runDoctor({
          cwd: context.cwd,
          ignoreConfig: true,
          env: context.env,
          pluginInspector: () => pluginUnsupported,
        });

        const label = client === "codex" ? "Codex" : "Claude Code";
        expect(output).toContain(`${label} integration: ${expectedMode}`);
        if (expectedMode === "cli-skill") {
          expect(output).toContain(
            "status: ready; MCP is optional for CLI plus Skill mode.",
          );
          expect(output).not.toContain(
            `next: run \`npx @kyo-so/cli setup ${client} --write\``,
          );
        }
        if (expectedMode === "skill-on-demand") {
          expect(output).toContain("npx: available");
          expect(output).toContain("bunx: missing");
        }
      },
    );
  }

  test("uses CODEX_HOME for the Codex MCP and HOME for the user Skill", async () => {
    const context = await doctorFixture();
    await writeCodexMcp(context.codexHome, true);
    const skillPath = join(
      context.home,
      ".agents",
      "skills",
      "kyoso-review",
      "SKILL.md",
    );
    await mkdir(join(skillPath, ".."), { recursive: true });
    await writeFile(skillPath, "skill", "utf8");
    await mkdir(join(context.home, ".codex"), { recursive: true });
    await writeFile(
      join(context.home, ".codex", "config.toml"),
      "[mcp_servers.kyoso]\nenabled = false\n",
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex integration: manual-mcp");
    expect(output).toContain(
      `manual MCP path(s): ${join(context.codexHome, "config.toml")}`,
    );
    expect(output).toContain(`manual Skill path(s): ${join(skillPath, "..")}`);
  });

  test("keeps existing MCP registrations visible after skill-only setup", async () => {
    for (const client of ["codex", "claude-code"] as const) {
      const context = await doctorFixture();
      const mcpPath = await createManualMcp(context, client);
      const before = await readFile(mcpPath, "utf8");

      const output = await runSetup({
        cwd: context.cwd,
        client,
        write: true,
        global: false,
        skillOnly: true,
        env: context.env,
      });
      const after = await readFile(mcpPath, "utf8");
      const doctor = await runDoctor({
        cwd: context.cwd,
        ignoreConfig: true,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      });

      const label = client === "codex" ? "Codex" : "Claude Code";
      expect(output).not.toContain(
        client === "codex" ? "Codex MCP" : "Claude Code MCP",
      );
      expect(after).toBe(before);
      expect(doctor).toContain(`${label} integration: manual-mcp`);
      expect(doctor).toContain("manual MCP: ok");
    }
  });

  test("uses the Plugin list as primary information and confirms effective MCP state", async () => {
    const context = await doctorFixture();
    let mcpListCalls = 0;
    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => {
        mcpListCalls += 1;
        return { status: "supported", kyoso: "enabled" };
      },
    });

    expect(output).toContain("Codex integration: plugin-mcp");
    expect(output).toContain("Plugin: installed, enabled");
    expect(output).toContain("Plugin MCP: enabled");
    expect(mcpListCalls).toBe(1);
  });

  test("keeps non-Plugin fallback while reporting unsupported Plugin detection", async () => {
    const context = await doctorFixture();
    await createSkill(context, "codex");
    await createExecutable(join(context.bin, "npx"));

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex integration: skill-on-demand");
    expect(output).toContain("Plugin: unsupported");
    expect(output).toContain(
      "Plugin detection unsupported: Codex Plugin list is unavailable.",
    );
  });

  test.each(["missing", "unknown"] as const)(
    "fails closed when the effective Plugin MCP state is %s",
    async (effectiveState) => {
      const context = await doctorFixture();
      const output = await runDoctor({
        cwd: context.cwd,
        ignoreConfig: true,
        env: context.env,
        pluginInspector: () => enabledPlugin(),
        mcpListInspector: () => ({
          status: "supported",
          kyoso: effectiveState,
        }),
      });

      expect(output).toContain("Codex integration: unknown");
      expect(output).toContain("Plugin MCP: unknown");
      expect(output).toContain(
        "Plugin MCP effective state is unknown; Plugin MCP mode was not inferred.",
      );
    },
  );

  test("fails closed when effective Plugin MCP inspection is unsupported", async () => {
    const context = await doctorFixture();
    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => ({
        status: "unsupported",
        failure: { operation: "mcp_list", reason: "timeout" },
      }),
    });

    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain(
      "Plugin MCP effective-state check unsupported: Codex MCP list timed out.",
    );
  });

  test("reports remediation for a disabled Plugin MCP without digest-checking transformed local Plugin source", async () => {
    const context = await doctorFixture();
    const pluginSkill = await copyPluginSourceFixture(context);
    const digest = await hashSkillDirectory(pluginSkill);
    expect(
      await readFile(join(pluginSkill, "agents", "openai.yaml"), "utf8"),
    ).toContain("dependencies:");
    expect(digest).not.toBe(CURRENT_SKILL_DIGEST);
    expect(knownSkillDigest(digest)).toBeUndefined();
    await mkdir(context.codexHome, { recursive: true });
    await writeFile(
      join(context.codexHome, "config.toml"),
      '[plugins."kyoso@kyoso".mcp_servers.kyoso]\nenabled = false\n',
      "utf8",
    );
    let mcpListCalls = 0;

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => {
        mcpListCalls += 1;
        return { status: "supported", kyoso: "disabled" };
      },
    });

    expect(output).toContain("Codex integration: plugin-skill");
    expect(output).toContain("Plugin MCP: disabled");
    expect(output).toContain(
      "status: bundled Plugin MCP is disabled; re-enable it or remove the Plugin and use CLI plus Skill-only.",
    );
    expect(output).not.toContain("unmanaged skill digest");
    expect(output).not.toContain("Plugin Skill and manual Skill copy coexist");
    expect(mcpListCalls).toBe(1);
  });

  test("fails closed when effective MCP contradicts a disabled Plugin override", async () => {
    const context = await doctorFixture();
    await mkdir(context.codexHome, { recursive: true });
    await writeFile(
      join(context.codexHome, "config.toml"),
      '[plugins."kyoso@kyoso".mcp_servers.kyoso]\nenabled = false\n',
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => ({ status: "supported", kyoso: "enabled" }),
    });

    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain(
      "Plugin MCP effective state does not match the recorded configuration precedence; Plugin MCP mode was not inferred.",
    );
  });

  test("fails closed when effective MCP contradicts an enabled Plugin override", async () => {
    const context = await doctorFixture();
    await mkdir(context.codexHome, { recursive: true });
    await writeFile(
      join(context.codexHome, "config.toml"),
      '[plugins."kyoso@kyoso".mcp_servers.kyoso]\nenabled = true\n',
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => ({ status: "supported", kyoso: "disabled" }),
    });

    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain(
      "Plugin MCP effective state does not match the recorded configuration precedence; Plugin MCP mode was not inferred.",
    );
  });

  test("keeps manual MCP primary when the Plugin MCP override is disabled", async () => {
    const context = await doctorFixture();
    await writeFile(
      join(context.codexHome, "config.toml"),
      [
        "[mcp_servers.kyoso]",
        "enabled = true",
        "",
        '[plugins."kyoso@kyoso".mcp_servers.kyoso]',
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await createSkill(context, "codex");
    let mcpListCalls = 0;

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => {
        mcpListCalls += 1;
        return { status: "supported", kyoso: "enabled" };
      },
    });

    expect(output).toContain("Codex integration: manual-mcp");
    expect(output).toContain("Plugin MCP: disabled by configuration override");
    expect(output).toContain(
      "Plugin MCP is disabled by configuration override while the manual MCP remains enabled.",
    );
    expect(mcpListCalls).toBe(0);
  });

  test("keeps manual MCP primary when an enabled Plugin overlaps", async () => {
    const context = await doctorFixture();
    await createManualMcp(context, "codex");
    await createSkill(context, "codex");
    let mcpListCalls = 0;

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => enabledPlugin(),
      mcpListInspector: () => {
        mcpListCalls += 1;
        return { status: "supported", kyoso: "enabled" };
      },
    });

    expect(output).toContain("Codex integration: manual-mcp");
    expect(output).toContain(
      "Plugin and manual Codex MCP registrations coexist",
    );
    expect(output).toContain("Plugin Skill and manual Skill copy coexist");
    expect(output).toContain(
      `manual Skill path(s): ${join(context.cwd, ".agents", "skills", "kyoso-review")}`,
    );
    expect(mcpListCalls).toBe(0);
  });

  test("layers a disabled Plugin warning over manual MCP", async () => {
    const context = await doctorFixture();
    await createManualMcp(context, "codex");
    await createSkill(context, "codex");

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => ({
        ...enabledPlugin(),
        plugin: {
          pluginId: "kyoso@kyoso",
          installed: true,
          enabled: false,
          state: "disabled",
        },
      }),
    });

    expect(output).toContain("Codex integration: manual-mcp");
    expect(output).toContain("Plugin: installed, disabled");
    expect(output).toContain("warning: Plugin disabled.");
  });

  test("does not treat a disabled manual MCP as an active registration", async () => {
    const context = await doctorFixture();
    await writeFile(
      join(context.codexHome, "config.toml"),
      "[mcp_servers.kyoso]\nenabled = false\n",
      "utf8",
    );
    await createSkill(context, "codex");
    await createInstalledCli(context);

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex integration: cli-skill");
    expect(output).toContain("manual MCP: disabled");
    expect(output).toContain("warning: Manual MCP registration is disabled.");
  });

  test("distinguishes project and global CLIs from npx cache and unknown PATH entries", async () => {
    const project = await doctorFixture();
    await createInstalledCli(project);
    expect(detectCli({ cwd: project.cwd, env: project.env }).kyoso).toEqual({
      kind: "installed",
      version: "9.9.9",
      scope: "project",
    });

    const global = await doctorFixture();
    const globalRoot = await mkdtemp(
      join(process.cwd(), ".kyoso-doctor-global-"),
    );
    try {
      const globalExecutable = await createCliPackage(globalRoot);
      await symlink(globalExecutable, join(global.bin, "kyoso"));
      expect(detectCli({ cwd: global.cwd, env: global.env }).kyoso).toEqual({
        kind: "installed",
        version: "9.9.9",
        scope: "global",
      });
    } finally {
      await rm(globalRoot, { recursive: true, force: true });
    }

    const cached = await doctorFixture();
    const cacheExecutable = await createCliPackage(
      join(cached.cwd, "node_modules", ".cache", "_npx", "kyoso"),
    );
    await symlink(cacheExecutable, join(cached.bin, "kyoso"));
    expect(detectCli({ cwd: cached.cwd, env: cached.env }).kyoso).toEqual({
      kind: "transient",
    });

    const unknown = await doctorFixture();
    const unknownBin = join(unknown.cwd, "bin");
    await mkdir(unknownBin, { recursive: true });
    await createExecutable(join(unknownBin, "kyoso"));
    unknown.env.PATH = unknownBin;
    expect(detectCli({ cwd: unknown.cwd, env: unknown.env }).kyoso).toEqual({
      kind: "unknown",
    });
  });

  test("continues CLI package discovery above malformed package metadata", async () => {
    const context = await doctorFixture();
    const packageRoot = join(context.cwd, "node_modules", "@kyo-so", "cli");
    const executable = await createCliPackage(packageRoot);
    await writeFile(join(packageRoot, "dist", "package.json"), "{", "utf8");
    await symlink(executable, join(context.bin, "kyoso"));

    expect(detectCli({ cwd: context.cwd, env: context.env }).kyoso).toEqual({
      kind: "installed",
      version: "9.9.9",
      scope: "project",
    });
  });

  test("resolves Windows command shims through PATHEXT", async () => {
    const context = await doctorFixture();
    const packageRoot = join(context.cwd, "node_modules", "@kyo-so", "cli");
    const bin = join(packageRoot, "dist", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@kyo-so/cli", version: "9.9.9" }),
      "utf8",
    );
    await createExecutable(join(bin, "kyoso.CMD"));
    await createExecutable(join(bin, "npx.CMD"));
    await createExecutable(join(bin, "bunx.EXE"));
    const env = { PATH: bin, PATHEXT: ".EXE;.CMD" };

    expect(detectCli({ cwd: context.cwd, env, platform: "win32" })).toEqual({
      kyoso: { kind: "installed", version: "9.9.9", scope: "project" },
      npx: true,
      bunx: true,
    });
  });
});

type DoctorFixture = {
  cwd: string;
  home: string;
  codexHome: string;
  bin: string;
  env: NodeJS.ProcessEnv;
};

async function doctorFixture(): Promise<DoctorFixture> {
  const root = await mkdtemp(join(tmpdir(), "kyoso-doctor-integration-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const bin = join(root, "bin");
  await Promise.all(
    [cwd, home, codexHome, bin].map((path) => mkdir(path, { recursive: true })),
  );
  return {
    cwd,
    home,
    codexHome,
    bin,
    env: { HOME: home, CODEX_HOME: codexHome, PATH: bin },
  };
}

async function applyIntegrationFixture(
  context: DoctorFixture,
  client: "codex" | "claude-code",
  fixture: { mcp?: boolean; skill?: boolean; cli?: boolean; npx?: boolean },
): Promise<void> {
  if (fixture.mcp) await createManualMcp(context, client);
  if (fixture.skill) await createSkill(context, client);
  if (fixture.cli) await createInstalledCli(context);
  if (fixture.npx) await createExecutable(join(context.bin, "npx"));
}

async function createManualMcp(
  context: DoctorFixture,
  client: "codex" | "claude-code",
): Promise<string> {
  if (client === "codex") {
    return writeCodexMcp(context.codexHome, true);
  }
  const path = join(context.cwd, ".mcp.json");
  await writeFile(
    path,
    `${JSON.stringify({ mcpServers: { kyoso: { enabled: true } } })}\n`,
    "utf8",
  );
  return path;
}

async function writeCodexMcp(
  codexHome: string,
  enabled: boolean,
): Promise<string> {
  const path = join(codexHome, "config.toml");
  await writeFile(path, `[mcp_servers.kyoso]\nenabled = ${enabled}\n`, "utf8");
  return path;
}

async function createSkill(
  context: DoctorFixture,
  client: "codex" | "claude-code",
): Promise<void> {
  const directory =
    client === "codex"
      ? join(context.cwd, ".agents", "skills", "kyoso-review")
      : join(context.cwd, ".claude", "skills", "kyoso-review");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "skill", "utf8");
}

async function copyPluginSourceFixture(
  context: DoctorFixture,
): Promise<string> {
  await mkdir(join(context.cwd, ".agents"), { recursive: true });
  await mkdir(join(context.cwd, "plugins"), { recursive: true });
  await cp(
    join(repositoryRoot, ".agents", "plugins"),
    join(context.cwd, ".agents", "plugins"),
    { recursive: true },
  );
  await cp(
    join(repositoryRoot, "plugins", "kyoso"),
    join(context.cwd, "plugins", "kyoso"),
    { recursive: true },
  );
  return join(context.cwd, "plugins", "kyoso", "skills", "kyoso-review");
}

async function createInstalledCli(context: DoctorFixture): Promise<void> {
  const executable = await createCliPackage(
    join(context.cwd, "node_modules", "@kyo-so", "cli"),
  );
  await symlink(executable, join(context.bin, "kyoso"));
}

async function createCliPackage(packageRoot: string): Promise<string> {
  const executable = join(packageRoot, "dist", "bin", "kyoso");
  await mkdir(join(executable, ".."), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@kyo-so/cli", version: "9.9.9" }),
    "utf8",
  );
  await createExecutable(executable);
  return executable;
}

async function createExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}

function enabledPlugin(): Extract<
  CodexPluginInspection,
  { status: "supported" }
> {
  return {
    status: "supported",
    codexVersion: "0.144.1",
    plugin: {
      pluginId: "kyoso@kyoso",
      installed: true,
      enabled: true,
      state: "enabled",
    },
  };
}
