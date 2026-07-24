import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cp,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodexPluginInspection } from "../../src/cli/codexPluginDetector.js";
import { runDoctor } from "../../src/cli/doctor.js";
import {
  detectCli,
  determineNonPluginIntegration,
} from "../../src/cli/integration.js";
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
      [
        "manual MCP and Skill",
        "manual-mcp",
        { mcp: true, npx: true, skill: true },
      ],
      ["installed CLI and Skill", "cli-skill", { cli: true, skill: true }],
      ["Skill and npx", "skill-on-demand", { npx: true, skill: true }],
      ["manual MCP only", "mcp-only", { mcp: true, npx: true }],
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
            `next: run \`npx -y --package=@kyo-so/cli kyoso setup ${client} --write\``,
          );
        }
        if (expectedMode === "skill-on-demand") {
          expect(output).toContain("npx: available");
          expect(output).toContain("bunx: missing");
        }
      },
    );
  }

  test("accepts the 35-minute review-wide budget for 15-minute primary and verification phases", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      "[reviewBudget]\nmaxTotalWallTimeMs = 2100000\n",
      "utf8",
    );
    await writeFile(
      join(context.cwd, "kyoso.toml"),
      `[agents.codex]
timeoutMs = 900000

[agents.claude]
timeoutMs = 900000

[verification]
enabled = true
timeoutMs = 900000
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("review-wide deadline: 2100000 ms");
    expect(output).toContain(
      "sequential phases: primary 900000 + verification 900000 + LLM judge 0 = 1800000 ms",
    );
    expect(output).toContain("recommended review-wide deadline: 1980000 ms");
    expect(output).not.toContain("warning: review-wide deadline");
  });

  test.each([
    [
      1_700_000,
      "warning: review-wide deadline is insufficient: 1700000 ms is below the configured sequential phase time of 1800000 ms",
    ],
    [
      1_900_000,
      "warning: review-wide deadline has low margin: 1900000 ms is below the recommended 1980000 ms",
    ],
  ] as const)(
    "warns when the %i ms review-wide budget cannot safely cover configured phases",
    async (maxTotalWallTimeMs, expectedWarning) => {
      const context = await doctorFixture();
      const globalConfigDir = join(context.home, ".config", "kyoso");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(
        join(globalConfigDir, "config.toml"),
        `[reviewBudget]\nmaxTotalWallTimeMs = ${maxTotalWallTimeMs}\n`,
        "utf8",
      );
      await writeFile(
        join(context.cwd, "kyoso.toml"),
        `[agents.codex]
timeoutMs = 900000

[agents.claude]
timeoutMs = 900000

[verification]
enabled = true
timeoutMs = 900000
`,
        "utf8",
      );

      const output = await runDoctor({
        cwd: context.cwd,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      });

      expect(output).toContain(expectedWarning);
      expect(output).toContain(
        "hint: set user-global reviewBudget.maxTotalWallTimeMs to at least 1980000.",
      );
    },
  );

  test("adds judge time only for a credential-backed LLM route", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      "[reviewBudget]\nmaxTotalWallTimeMs = 350000\n",
      "utf8",
    );
    await writeFile(
      join(context.cwd, "kyoso.toml"),
      `[agents.codex]
timeoutMs = 100000

[agents.claude]
timeoutMs = 100000

[judge]
mode = "deterministic_plus_llm"
provider = "openai"
timeoutMs = 200000
`,
      "utf8",
    );

    const withoutCredential = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });
    const withCredential = await runDoctor({
      cwd: context.cwd,
      env: { ...context.env, OPENAI_API_KEY: "doctor-test-key" },
      pluginInspector: () => pluginUnsupported,
    });

    expect(withoutCredential).toContain(
      "sequential phases: primary 100000 + verification 0 + LLM judge 0 = 100000 ms",
    );
    expect(withoutCredential).toContain(
      "Judge\n  provider: deterministic_fallback",
    );
    expect(withCredential).toContain(
      "sequential phases: primary 100000 + verification 0 + LLM judge 200000 = 300000 ms",
    );
    expect(withCredential).toContain("Judge\n  provider: openai");
    expect(withCredential).toContain(
      "warning: review-wide deadline has low margin: 350000 ms is below the recommended 360000 ms",
    );
    expect(withCredential).not.toContain("doctor-test-key");
  });

  test("reports OpenRouter key presence without leaking its value", async () => {
    const context = await doctorFixture();
    const fakeKey = "openrouter-test-key-must-not-appear";
    await mkdir(join(context.home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(context.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(context.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      join(context.cwd, "kyoso.toml"),
      '[agents.codex]\nprovider = "openrouter"\nmodel = "openai/o4-mini"\n',
      "utf8",
    );

    const detected = await runDoctor({
      cwd: context.cwd,
      env: { ...context.env, OPENROUTER_API_KEY: fakeKey },
      pluginInspector: () => pluginUnsupported,
    });
    const missing = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(detected).toContain("provider: openrouter");
    expect(detected).toContain("model: openai/o4-mini");
    expect(detected).toContain("auth: detected OPENROUTER_API_KEY");
    expect(detected).toContain(
      "can route Codex review content through OpenRouter",
    );
    expect(detected).not.toContain(fakeKey);
    expect(missing).toContain(
      "warning: OPENROUTER_API_KEY is not visible to the Kyoso process",
    );
    expect(missing).toContain("restart the client, then run `kyoso doctor`");
    expect(missing).not.toContain(fakeKey);

    await writeFile(
      join(context.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(context.cwd)}]

[agents.codex.env]
OPENROUTER_API_KEY = "openrouter-configured-test-key"
`,
      "utf8",
    );
    const configured = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(configured).toContain(
      "auth: detected OPENROUTER_API_KEY from agents.codex.env",
    );
    expect(configured).not.toContain("openrouter-configured-test-key");

    const placeholderContext = await doctorFixture();
    await mkdir(join(placeholderContext.home, ".config", "kyoso"), {
      recursive: true,
    });
    await writeFile(
      join(placeholderContext.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(placeholderContext.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      join(placeholderContext.cwd, "kyoso.toml"),
      '[agents.codex]\nprovider = "openrouter"\nmodel = "openai/o4-mini"\n',
      "utf8",
    );
    const placeholder = await runDoctor({
      cwd: placeholderContext.cwd,
      env: {
        ...placeholderContext.env,
        OPENROUTER_API_KEY: "${OPENROUTER_API_KEY}",
      },
      pluginInspector: () => pluginUnsupported,
    });

    expect(placeholder).toContain(
      "warning: OPENROUTER_API_KEY placeholder was not expanded by the client",
    );
  });

  test("reports configured and inherited OpenRouter retry reliability", async () => {
    const configuredContext = await doctorFixture();
    await mkdir(join(configuredContext.home, ".config", "kyoso"), {
      recursive: true,
    });
    await writeFile(
      join(configuredContext.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(configuredContext.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      join(configuredContext.cwd, "kyoso.toml"),
      `[agents.codex]
provider = "openrouter"
model = "openai/o4-mini"
timeoutMs = 360000

[agents.codex.openRouter]
streamIdleTimeoutMs = 90000
streamMaxRetries = 3
requestMaxRetries = 2
`,
      "utf8",
    );

    const configured = await runDoctor({
      cwd: configuredContext.cwd,
      env: configuredContext.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(configured).toContain("reliability:");
    expect(configured).toContain(
      "stream idle timeout: 90000 ms (Kyoso config)",
    );
    expect(configured).toContain("stream retries: 3");
    expect(configured).toContain("request retries: 2");
    expect(configured).toContain(
      "maximum idle-only stream window: approximately 360000 ms plus backoff",
    );
    expect(configured).toContain(
      "warning: configured idle-only retry window can consume the entire Codex agent timeout (timeoutMs=360000).",
    );

    const inheritedContext = await doctorFixture();
    await mkdir(join(inheritedContext.home, ".config", "kyoso"), {
      recursive: true,
    });
    await writeFile(
      join(inheritedContext.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(inheritedContext.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      join(inheritedContext.cwd, "kyoso.toml"),
      '[agents.codex]\nprovider = "openrouter"\nmodel = "openai/o4-mini"\n',
      "utf8",
    );

    const inherited = await runDoctor({
      cwd: inheritedContext.cwd,
      env: inheritedContext.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(inherited).toContain(
      "stream idle timeout: inherited from Codex runtime",
    );
    expect(inherited).toContain("stream retries: inherited from Codex runtime");
    expect(inherited).toContain(
      "request retries: inherited from Codex runtime",
    );
  });

  test("sanitizes a project OpenRouter model before rendering doctor output", async () => {
    const context = await doctorFixture();
    await mkdir(join(context.home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(context.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(context.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      join(context.cwd, "kyoso.toml"),
      `[agents.codex]
provider = "openrouter"
model = "openai/o4-mini\\u001b[31m\\nforged"
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("model: openai/o4-mini forged");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("model: openai/o4-mini\nforged");
  });

  test("keeps doctor best-effort for schema-invalid Codex provider and model config", async () => {
    const cases = [
      {
        config: '[agents.codex]\nprovider = "unsupported-provider"\n',
        issuePath: "agents.codex.provider",
      },
      {
        config: '[agents.codex]\nprovider = "openrouter"\nmodel = ""\n',
        issuePath: "agents.codex.model",
      },
    ] as const;

    for (const testCase of cases) {
      const context = await doctorFixture();
      const globalConfigDir = join(context.home, ".config", "kyoso");
      const globalConfigPath = join(globalConfigDir, "config.toml");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(globalConfigPath, testCase.config, "utf8");

      const output = await runDoctor({
        cwd: context.cwd,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      });

      expect(output).toContain("Kyoso doctor");
      expect(output).toContain(
        "warning: invalid Codex OpenRouter configuration:",
      );
      expect(output).toContain(testCase.issuePath);
      expect(output).toContain(
        "Doctor is using safe defaults for diagnostics.",
      );
      expect(output).toContain(
        'hint: set agents.codex.provider = "openrouter" with a non-empty agents.codex.model',
      );
      expect(output).toContain(
        "global config.toml: not applied in safe-default diagnostics",
      );
      expect(output).toContain(
        "kyoso.toml: not applied in safe-default diagnostics",
      );
      expect(output).toContain(
        "kyoso.config.ts: not applied in safe-default diagnostics",
      );
      expect(output).not.toContain(
        `global config.toml: not applied after validation failure; check ${globalConfigPath}`,
      );
    }
  });

  test("marks fallback agent diagnostics as safe defaults and suppresses command migration hints", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      '[agents.codex]\nprovider = "unsupported-provider"\n',
      "utf8",
    );
    await createExecutable(join(context.bin, "bunx"));

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain(
      "note: user-global config is not reflected; all agent diagnostics below use safe defaults.",
    );
    expect(output).toContain("Codex: warning command not found");
    expect(output).toContain(
      "command: npx -y @agentclientprotocol/codex-acp@1.1.5",
    );
    expect(output).not.toContain(
      'hint: set agents.<name>.command = "bunx" in config.toml',
    );
  });

  test("keeps doctor best-effort for legacy and relative project provider allowlists", async () => {
    const cases = [
      {
        config: "[agents.codex]\nallowProjectProvider = true\n",
        issuePath: "agents.codex.allowProjectProvider",
      },
      {
        config: '[agents.codex]\nallowProjectProvider = ["."]\n',
        issuePath: "agents.codex.allowProjectProvider.0",
      },
    ] as const;

    for (const testCase of cases) {
      const context = await doctorFixture();
      const globalConfigDir = join(context.home, ".config", "kyoso");
      await mkdir(globalConfigDir, { recursive: true });
      await writeFile(
        join(globalConfigDir, "config.toml"),
        testCase.config,
        "utf8",
      );

      const output = await runDoctor({
        cwd: context.cwd,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      });

      expect(output).toContain("Kyoso doctor");
      expect(output).toContain(
        "warning: invalid Codex OpenRouter configuration:",
      );
      expect(output).toContain(testCase.issuePath);
      expect(output).toContain(
        "Doctor is using safe defaults for diagnostics.",
      );
      expect(output).toContain(
        "hint: migrate user-global agents.codex.allowProjectProvider to an absolute directory string[] for exact matching",
      );
      expect(output).toContain(
        'allowProjectProvider = ["/absolute/project-directory"]',
      );
      expect(output).toContain(
        "global config.toml: not applied in safe-default diagnostics",
      );
    }
  });

  test("keeps doctor best-effort for mixed OpenRouter and unrelated schema errors", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      `[agents.codex]
provider = "unsupported-provider"

[workspace]
maxContextBytes = 0
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Kyoso doctor");
    expect(output).toContain(
      "warning: invalid Codex OpenRouter configuration:",
    );
    expect(output).toContain("agents.codex.provider");
    expect(output).toContain("workspace.maxContextBytes");
    expect(output).toContain(
      "global config.toml: not applied in safe-default diagnostics",
    );
  });

  test("keeps doctor best-effort for an unauthorized project OpenRouter selection", async () => {
    const context = await doctorFixture();
    const projectDirectory = await realpath(context.cwd);
    const globalConfigPath = join(
      context.home,
      ".config",
      "kyoso",
      "config.toml",
    );
    await writeFile(
      join(context.cwd, "kyoso.toml"),
      '[agents.codex]\nprovider = "openrouter"\nmodel = "openai/o4-mini"\n',
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Kyoso doctor");
    expect(output).toContain(
      `warning: project config ${join(context.cwd, "kyoso.toml")} changes Codex OpenRouter routing without user-global authorization.`,
    );
    expect(output).toContain("Doctor is using safe defaults for diagnostics.");
    expect(output).toContain(
      `hint: add the exact project directory ${JSON.stringify(projectDirectory)} to agents.codex.allowProjectProvider in user-global ${globalConfigPath} (for a new list: allowProjectProvider = [${JSON.stringify(projectDirectory)}]), then run \`kyoso doctor\` again`,
    );
    expect(output).toContain(
      "global config.toml: not applied in safe-default diagnostics",
    );
    expect(output).toContain(
      `kyoso.toml: not applied after validation failure; check ${join(context.cwd, "kyoso.toml")}`,
    );
    expect(output).not.toContain(
      `global config.toml: not applied after validation failure; check ${globalConfigPath}`,
    );
    expect(output).not.toContain("provider: openrouter");
  });

  test("reports the actual trusted legacy config that lacks OpenRouter authorization", async () => {
    const context = await doctorFixture();
    const configPath = join(context.cwd, "kyoso.config.ts");
    const trustStorePath = join(context.cwd, "trusted-configs.json");
    await writeFile(
      configPath,
      `export default {
  agents: {
    codex: {
      provider: "openrouter",
      model: "openai/o4-mini",
    },
  },
};
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      trustConfig: true,
      trustStorePath,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain(
      `warning: project config ${configPath} changes Codex OpenRouter routing without user-global authorization.`,
    );
    expect(output).toContain(
      `kyoso.config.ts: not applied after validation failure; check ${configPath}`,
    );
    expect(output).toContain(
      "kyoso.toml: not applied in safe-default diagnostics",
    );
    expect(output).toContain(
      "trusted config: executed but not applied after authorization failure",
    );
  });

  test("reports trusted legacy config execution after its OpenRouter validation fails", async () => {
    const context = await doctorFixture();
    const configPath = join(context.cwd, "kyoso.config.ts");
    const trustStorePath = join(context.cwd, "trusted-configs.json");
    await mkdir(join(context.home, ".config", "kyoso"), { recursive: true });
    await writeFile(
      join(context.home, ".config", "kyoso", "config.toml"),
      `[agents.codex]
allowProjectProvider = [${JSON.stringify(context.cwd)}]
`,
      "utf8",
    );
    await writeFile(
      configPath,
      `export default {
  agents: {
    codex: {
      provider: "openrouter",
    },
  },
};
`,
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      env: context.env,
      trustConfig: true,
      trustStorePath,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain(
      "warning: invalid Codex OpenRouter configuration:",
    );
    expect(output).toContain("agents.codex.model");
    expect(output).toContain(
      `kyoso.config.ts: not applied after validation failure; check ${configPath}`,
    );
    expect(output).toContain(
      "trusted config: executed but not applied after validation failure",
    );
    expect(output).not.toContain(
      "trusted config: not evaluated after validation failure",
    );
  });

  test("preserves doctor failures for unrelated schema-invalid config", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      "[workspace]\nmaxContextBytes = 0\n",
      "utf8",
    );

    await expect(
      runDoctor({
        cwd: context.cwd,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      }),
    ).rejects.toThrow();
  });

  test("does not treat an ordinary Codex model type error as an OpenRouter fallback", async () => {
    const context = await doctorFixture();
    const globalConfigDir = join(context.home, ".config", "kyoso");
    await mkdir(globalConfigDir, { recursive: true });
    await writeFile(
      join(globalConfigDir, "config.toml"),
      "[agents.codex]\nmodel = 42\n",
      "utf8",
    );

    await expect(
      runDoctor({
        cwd: context.cwd,
        env: context.env,
        pluginInspector: () => pluginUnsupported,
      }),
    ).rejects.toThrow();
  });

  test("uses CODEX_HOME for the Codex MCP and HOME for the user Skill", async () => {
    const context = await doctorFixture();
    await writeCodexMcp(context.codexHome, true);
    await createExecutable(join(context.bin, "npx"));
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
      await createExecutable(join(context.bin, "npx"));
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

  test("does not report an enabled legacy manual MCP as ready", async () => {
    const context = await doctorFixture();
    await writeFile(
      join(context.codexHome, "config.toml"),
      '[mcp_servers.kyoso]\ncommand = "npx"\nargs = ["-y", "@kyo-so/cli", "mcp"]\nenabled = true\n',
      "utf8",
    );
    await createExecutable(join(context.bin, "npx"));
    await createSkill(context, "codex");

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex registration: repair required (legacy)");
    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain(
      "npx -y --package=@kyo-so/cli kyoso setup codex --write --runner npx --force",
    );
    expect(output).not.toContain("Codex integration: manual-mcp");
  });

  test("prints a client-specific legacy repair command for Claude project MCP", async () => {
    const context = await doctorFixture();
    await createExecutable(join(context.bin, "npx"));
    await writeFile(
      join(context.cwd, ".mcp.json"),
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain(
      "Claude Code registration: repair required (legacy)",
    );
    expect(output).toContain(
      "npx -y --package=@kyo-so/cli kyoso setup claude-code --write --runner npx --force",
    );
  });

  test("prints an executable npx repair command for a legacy bunx MCP", async () => {
    const context = await doctorFixture();
    await createExecutable(join(context.bin, "npx"));
    await createExecutable(join(context.bin, "bunx"));
    await writeFile(
      join(context.cwd, ".mcp.json"),
      '{"mcpServers":{"kyoso":{"command":"bunx","args":["@kyo-so/cli","mcp"]}}}\n',
      "utf8",
    );

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain(
      "npx -y --package=@kyo-so/cli kyoso setup claude-code --write --runner npx --force",
    );
  });

  test("reports overlapping Claude MCP scopes as unknown", async () => {
    const context = await doctorFixture();
    await createManualMcp(context, "claude-code");
    await writeFile(
      join(context.home, ".claude.json"),
      '{"mcpServers":{"kyoso":{"command":"npx","args":["-y","--package=@kyo-so/cli","kyoso","mcp"]}}}\n',
      "utf8",
    );
    await createExecutable(join(context.bin, "npx"));

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Claude Code registration: unknown");
    expect(output).toContain("Claude Code integration: unknown");
    expect(output).toContain(join(context.cwd, ".mcp.json"));
    expect(output).toContain(join(context.home, ".claude.json"));
  });

  test.each([
    ["legacy", ["-y", "@kyo-so/cli", "mcp"]],
    ["custom", ["-y", "@kyo-so/cli@latest", "mcp"]],
  ] as const)(
    "does not infer Plugin MCP from an enabled %s manual registration",
    async (_kind, args) => {
      const context = await doctorFixture();
      await writeFile(
        join(context.codexHome, "config.toml"),
        [
          "[mcp_servers.kyoso]",
          'command = "npx"',
          `args = ${JSON.stringify(args)}`,
          "enabled = true",
          "",
        ].join("\n"),
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
          return { status: "supported", kyoso: "enabled" };
        },
      });

      expect(output).toContain("Codex integration: unknown");
      expect(output).toContain("Plugin MCP: unknown");
      expect(output).toContain(
        "Plugin MCP origin is unknown because an enabled manual MCP registration is legacy, custom, unverified, or its runner is unavailable.",
      );
      expect(output).not.toContain("Codex integration: plugin-mcp");
      expect(mcpListCalls).toBe(0);
    },
  );

  test("does not treat a present-but-unverified bunx as a Skill fallback", async () => {
    const context = await doctorFixture();
    await createSkill(context, "codex");
    await createExecutable(join(context.bin, "bunx"));

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex integration: missing");
    expect(output).toContain("bunx: present-unverified");
    expect(output).toContain("bunx is present but unverified");
  });

  test("does not execute bunx while reporting a current manual MCP as unverified", async () => {
    const context = await doctorFixture();
    const invocationPath = join(context.cwd, "bunx-invocation");
    const bunxPath = join(context.bin, "bunx");
    await writeFile(
      join(context.codexHome, "config.toml"),
      '[mcp_servers.kyoso]\ncommand = "bunx"\nargs = ["--package", "@kyo-so/cli", "kyoso", "mcp"]\nenabled = true\n',
      "utf8",
    );
    await createSkill(context, "codex");
    await createExecutable(join(context.bin, "npx"));
    await writeFile(
      bunxPath,
      `#!/bin/sh\ntouch ${JSON.stringify(invocationPath)}\nexit 0\n`,
      "utf8",
    );
    await chmod(bunxPath, 0o755);

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex registration: bunx unverified");
    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain("bunx: present-unverified");
    expect(output).toContain(
      "normal doctor does not verify the required Bun capability",
    );
    expect(output).toContain(
      "npx -y --package=@kyo-so/cli kyoso setup codex --write --runner bunx",
    );
    expect(existsSync(invocationPath)).toBe(false);
  });

  test("does not report a current npx manual MCP as ready when npx is missing", async () => {
    const context = await doctorFixture();
    await writeCodexMcp(context.codexHome, true);
    await createSkill(context, "codex");

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Codex registration: npx missing");
    expect(output).toContain("Codex integration: unknown");
    expect(output).toContain(
      "Manual MCP registration uses npx, but npx is not available on PATH.",
    );
  });

  test("does not report an execution-altering manual MCP environment as ready", async () => {
    const context = await doctorFixture();
    await writeFile(
      join(context.cwd, ".mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          kyoso: {
            command: "npx",
            args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
            env: { NODE_OPTIONS: "--require /tmp/payload.js" },
          },
        },
      })}\n`,
      "utf8",
    );
    await createExecutable(join(context.bin, "npx"));

    const output = await runDoctor({
      cwd: context.cwd,
      ignoreConfig: true,
      env: context.env,
      pluginInspector: () => pluginUnsupported,
    });

    expect(output).toContain("Claude Code registration: custom/unverified");
    expect(output).toContain("Claude Code integration: unknown");
    expect(output).toContain(
      "Manual MCP registration is custom/unverified and was not treated as a ready Kyoso registration.",
    );
  });

  test("does not warn about an absent manual MCP registration", () => {
    const integration = determineNonPluginIntegration({
      manualMcpStatus: "missing",
      manualMcpRegistrations: [],
      hasSkill: false,
      cli: {
        kyoso: { kind: "missing" },
        npx: "missing",
        bunx: "missing",
      },
    });

    expect(integration.mode).toBe("missing");
    expect(integration.warnings).toEqual([]);
  });

  test("fails closed when an enabled MCP has no exact registration", () => {
    const integration = determineNonPluginIntegration({
      manualMcpStatus: "enabled",
      manualMcpRegistrations: [],
      hasSkill: true,
      cli: {
        kyoso: { kind: "missing" },
        npx: "missing",
        bunx: "missing",
      },
    });

    expect(integration.mode).toBe("unknown");
    expect(integration.warnings).toContain(
      "Manual MCP registration is enabled but no exact registration could be verified.",
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
        'command = "npx"',
        'args = ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"]',
        "enabled = true",
        "",
        '[plugins."kyoso@kyoso".mcp_servers.kyoso]',
        "enabled = false",
        "",
      ].join("\n"),
      "utf8",
    );
    await createExecutable(join(context.bin, "npx"));
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
    await createExecutable(join(context.bin, "npx"));
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
    await createExecutable(join(context.bin, "npx"));
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
      npx: "available",
      bunx: "present-unverified",
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
    `${JSON.stringify({
      mcpServers: {
        kyoso: {
          command: "npx",
          args: ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"],
          enabled: true,
        },
      },
    })}\n`,
    "utf8",
  );
  return path;
}

async function writeCodexMcp(
  codexHome: string,
  enabled: boolean,
): Promise<string> {
  const path = join(codexHome, "config.toml");
  await writeFile(
    path,
    `[mcp_servers.kyoso]\ncommand = "npx"\nargs = ["-y", "--package=@kyo-so/cli", "kyoso", "mcp"]\nenabled = ${enabled}\n`,
    "utf8",
  );
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
