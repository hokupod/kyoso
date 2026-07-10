import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CURRENT_SKILL_DIGEST } from "../../src/cli/knownSkillDigests.js";
import { hashSkillDirectory } from "../../src/cli/skillInstall.js";

const root = process.cwd();

describe("Codex Plugin fixture", () => {
  test("uses the fixed marketplace, plugin, and MCP identities", async () => {
    const marketplace = await readJson(
      join(root, ".agents", "plugins", "marketplace.json"),
    );
    const manifest = await readJson(
      join(root, "plugins", "kyoso", ".codex-plugin", "plugin.json"),
    );
    const mcp = await readJson(join(root, "plugins", "kyoso", ".mcp.json"));

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
      version: "0.1.0",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      license: "AGPL-3.0-or-later",
      interface: { capabilities: ["Read"] },
    });
    expect(mcp).toEqual({
      kyoso: {
        command: "npx",
        args: ["-y", "@kyo-so/cli@0.8.0", "mcp"],
        env_vars: [
          "OPENAI_API_KEY",
          "CODEX_API_KEY",
          "CODEX_HOME",
          "CODEX_ACCESS_TOKEN",
          "ANTHROPIC_API_KEY",
          "CLAUDE_CODE_OAUTH_TOKEN",
        ],
        startup_timeout_sec: 20,
        tool_timeout_sec: 360,
      },
    });
  });

  test("keeps the Plugin Skill identical to the canonical MCP-optional Skill", async () => {
    const canonical = join(root, ".agents", "skills", "kyoso-review");
    const plugin = join(root, "plugins", "kyoso", "skills", "kyoso-review");

    expect(await hashSkillDirectory(canonical)).toBe(CURRENT_SKILL_DIGEST);
    expect(await hashSkillDirectory(plugin)).toBe(CURRENT_SKILL_DIGEST);
    expect(await directorySnapshot(plugin)).toEqual(
      await directorySnapshot(canonical),
    );
    expect(
      await readFile(join(canonical, "agents", "openai.yaml"), "utf8"),
    ).not.toContain("dependencies:");
  });

  test("records both probed Codex CLI versions and the minimum version", async () => {
    const mcp = await readJson(join(root, "plugins", "kyoso", ".mcp.json"));
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
