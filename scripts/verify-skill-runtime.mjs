import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auth = process.env.CODEX_AUTH_JSON;
if (!auth) {
  throw new Error(
    "CODEX_AUTH_JSON is required so the disposable CODEX_HOME can authenticate Codex",
  );
}
const parentEnvironment = { ...process.env };
delete parentEnvironment.CODEX_AUTH_JSON;

const bin = join(root, "dist", "bin", "kyoso.js");
if (!existsSync(bin)) {
  throw new Error(
    "Build the CLI before running the Skill runtime verification",
  );
}

const runtimeRoot = mkdtempSync(join(tmpdir(), "kyoso-skill-runtime-"));
const home = join(runtimeRoot, "home");
const codexHome = join(runtimeRoot, "codex-home");
const workspace = join(runtimeRoot, "workspace");
const fakeBin = join(runtimeRoot, "bin");
const fakeLog = join(runtimeRoot, "fake-kyoso.log");
const output = join(runtimeRoot, "codex-last-message.txt");

try {
  for (const path of [home, codexHome, workspace, fakeBin]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(codexHome, "auth.json"), auth, {
    encoding: "utf8",
    mode: 0o600,
  });
  writeFakeKyoso(join(fakeBin, "kyoso"), fakeLog);

  const environment = {
    ...parentEnvironment,
    CODEX_HOME: codexHome,
    HOME: home,
    PATH: `${fakeBin}${delimiter}${parentEnvironment.PATH ?? ""}`,
  };
  run("node", [bin, "setup", "codex", "--write", "--skill-only", "--global"], {
    cwd: workspace,
    env: environment,
  });

  const installedSkill = join(
    home,
    ".agents",
    "skills",
    "kyoso-review",
    "SKILL.md",
  );
  if (!existsSync(installedSkill)) {
    throw new Error(
      "Skill-only setup did not install kyoso-review into disposable HOME",
    );
  }
  const configPath = join(codexHome, "config.toml");
  if (existsSync(configPath)) {
    throw new Error(
      "Skill-only setup unexpectedly wrote CODEX_HOME/config.toml",
    );
  }

  run(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--cd",
      workspace,
      "--output-last-message",
      output,
      [
        "Use the kyoso-review Skill for a plan review smoke test.",
        "No Kyoso MCP server is registered.",
        "Run the PATH kyoso fallback for a tiny plan review with --json.",
        "The PATH executable is a fake fixture: report its JSON result and do not start a real Kyoso or provider review.",
      ].join(" "),
    ],
    { cwd: workspace, env: environment },
  );

  const fakeCalls = existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : "";
  if (!fakeCalls.includes("plan") || !fakeCalls.includes("--json")) {
    throw new Error(
      "Codex did not use the fake PATH kyoso CLI fallback for a JSON plan review",
    );
  }
  if (fakeCalls.includes('"codexAuthJsonPresent":true')) {
    throw new Error(
      "Codex auth bootstrap secret was inherited by the fake PATH fallback",
    );
  }
  if (!existsSync(output)) {
    throw new Error("Codex Skill smoke did not produce a final response");
  }

  console.log(
    "skill runtime verify ok: MCP-less Skill used the fake PATH kyoso fallback",
  );
} finally {
  rmSync(runtimeRoot, { force: true, recursive: true });
}

function writeFakeKyoso(path, logPath) {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), codexAuthJsonPresent: Object.hasOwn(process.env, "CODEX_AUTH_JSON") }) + "\\n");`,
      'console.log(JSON.stringify({ decision: "approve", degraded: false, findings: [], verdict: "fake skill smoke" }));',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(path, 0o700);
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 5 * 60_000,
  });
  if (result.error) {
    throw new Error(`${command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`,
    );
  }
}
