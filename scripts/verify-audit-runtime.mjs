import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "dist", "bin", "kyoso.js");
const fakeAgent = join(root, "test", "fixtures", "fake-acp-agent.ts");
const agentRuntime = process.env.KYOSO_AUDIT_AGENT_RUNTIME ?? "bun";

if (!existsSync(bin)) {
  throw new Error(
    "Build the CLI before running the audit runtime verification",
  );
}
if (!existsSync(fakeAgent)) {
  throw new Error("Fake ACP agent fixture is missing");
}

const runtimeRoot = mkdtempSync(join(tmpdir(), "kyoso-audit-runtime-"));
const workspace = join(runtimeRoot, "workspace");
const stateHome = join(runtimeRoot, "state");
const home = join(runtimeRoot, "home");
const configHome = join(runtimeRoot, "config");
const outside = join(runtimeRoot, "outside");
const canary = join(outside, "canary.jsonl");
const canaryContent = "audit runtime canary\n";

try {
  mkdirSync(join(workspace, "src"), { recursive: true, mode: 0o700 });
  mkdirSync(stateHome, { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(configHome, "kyoso"), { recursive: true, mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(workspace, "src", "foo.ts"), "export const foo = 1;\n");
  writeFileSync(canary, canaryContent, { encoding: "utf8", mode: 0o600 });
  symlinkSync(outside, join(workspace, ".kyoso"), "dir");
  writeGlobalConfig(join(configHome, "kyoso", "config.toml"));

  const result = runBuiltCli();
  const review = parseReviewResult(result.stdout);
  assertSuccessfulAudit(review);

  const tracePath = expectedTracePath(review.audit);
  if (!existsSync(tracePath)) {
    throw new Error("Built CLI did not create the expected XDG audit trace");
  }
  if (!lstatSync(tracePath).isFile()) {
    throw new Error("Built CLI audit trace is not a regular file");
  }
  const eventTypes = readFileSync(tracePath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line).type);
  if (
    !eventTypes.includes("request_received") ||
    !eventTypes.includes("response_sent")
  ) {
    throw new Error("Built CLI audit trace is missing finalized review events");
  }
  if (readFileSync(canary, "utf8") !== canaryContent) {
    throw new Error("Workspace audit symlink modified the outside canary");
  }
  if (readdirSync(outside).join(",") !== "canary.jsonl") {
    throw new Error(
      "Workspace audit symlink created a file outside XDG_STATE_HOME",
    );
  }
  if (existsSync(join(home, ".local", "state", "kyoso"))) {
    throw new Error(
      "Audit runtime verification wrote to HOME instead of XDG_STATE_HOME",
    );
  }

  console.log(
    `audit runtime verify ok: ${runtimeName()} built CLI writes only below temporary XDG_STATE_HOME`,
  );
} finally {
  rmSync(runtimeRoot, { force: true, recursive: true });
}

function writeGlobalConfig(path) {
  writeFileSync(
    path,
    [
      "[agents.codex]",
      `command = ${JSON.stringify(agentRuntime)}`,
      `args = [\"run\", ${JSON.stringify(fakeAgent)}]`,
      "timeoutMs = 5000",
      "",
      "[agents.codex.env]",
      'FAKE_ACP_FINDING_SEVERITY = "none"',
      "",
      "[agents.claude]",
      "enabled = false",
      "",
      "[judge]",
      'mode = "deterministic_only"',
      'provider = "none"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

function runBuiltCli() {
  const result = spawnSync(
    process.execPath,
    [
      bin,
      "plan",
      "--goal",
      "verify built audit trace containment",
      "--plan",
      "Use the fake ACP agent and record a trace.",
      "--file",
      "src/foo.ts",
      "--json",
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        ANTHROPIC_API_KEY: "",
      },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    },
  );
  if (result.error) {
    throw new Error(
      `Built CLI audit verification failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Built CLI audit verification exited with ${result.status ?? "an unknown status"}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function parseReviewResult(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("Built CLI audit verification did not return JSON");
  }
}

function assertSuccessfulAudit(review) {
  if (!review.audit?.traceId || !review.audit?.startedAt) {
    throw new Error("Built CLI response does not include audit trace metadata");
  }
  if (review.degraded) {
    throw new Error("Built CLI audit verification returned a degraded review");
  }
  const warnings = review.audit.warnings ?? [];
  if (
    warnings.some((warning) =>
      /^(AUDIT_DISABLED_|AUDIT_WRITE_FAILED|AUDIT_FINALIZE_FAILED)/.test(
        warning,
      ),
    )
  ) {
    throw new Error(
      "Built CLI reported an audit write or finalization failure",
    );
  }
}

function expectedTracePath(audit) {
  const workspaceHash = createHash("sha256")
    .update(realpathSync(workspace))
    .digest("hex");
  const date = audit.startedAt.slice(0, 10);
  return join(
    stateHome,
    "kyoso",
    "workspaces",
    workspaceHash,
    ".kyoso",
    "traces",
    date,
    `${audit.traceId}.jsonl`,
  );
}

function runtimeName() {
  return process.versions.bun
    ? `Bun ${process.versions.bun}`
    : `Node ${process.version}`;
}
