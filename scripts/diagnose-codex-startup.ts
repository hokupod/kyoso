// Temporary PR-only diagnosis; no live model credentials or release gates.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SubprocessAcpAgentManager } from "../src/acp/AcpAgentProcess.js";
import { defaultConfig } from "../src/config/defaultConfig.js";
import { kyosoConfigSchema } from "../src/config/schema.js";
import { sanitizeTextForDisplay } from "../src/security/sanitizeText.js";
import { startMockResponsesServer } from "../test/fixtures/mockResponsesServer.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv[2] === "--proxy") {
  const [log, command, ...args] = process.argv.slice(3);
  if (!log || !command) throw new Error("Missing proxy arguments");
  const started = Date.now();
  const record = (kind: string, data: unknown) =>
    appendFileSync(
      log,
      JSON.stringify({ ms: Date.now() - started, kind, data }) + "\n",
    );
  record("launch", { command, args });
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  process.stdin.pipe(child.stdin);
  child.stdin.on("error", (error) => record("stdin-error", error.message));
  child.stdout.on("data", (chunk: Buffer) => {
    record("stdout", { bytes: chunk.length });
    process.stdout.write(chunk);
  });
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < 16000)
      record(
        "stderr",
        sanitizeTextForDisplay(chunk.toString().slice(0, 16000 - stderrBytes)),
      );
    stderrBytes += chunk.length;
  });
  const killGroup = (signal: NodeJS.Signals) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    }
  };
  child.on("error", (error) => {
    record("spawn-error", error.message);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => {
    killGroup("SIGKILL");
    record("closed", { code, signal });
    process.exit(code ?? 1);
  });
  let stopping = false;
  process.on("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    record("terminate", null);
    killGroup("SIGTERM");
    setTimeout(() => {
      killGroup("SIGKILL");
      record("closed", "forced");
      process.exit(143);
    }, 1500);
  });
} else {
  const command = process.argv[2];
  if (!command)
    throw new Error("Usage: bun scripts/diagnose-codex-startup.ts <npx path>");
  const root = await mkdtemp(join(tmpdir(), "kyoso-startup-diagnostic-"));
  const home = join(root, "home");
  await mkdir(home);
  console.log(
    JSON.stringify({
      runtime: {
        bun: Bun.version,
        nodeCommand: command,
        platform: process.platform,
        arch: process.arch,
      },
      observationTimeoutMs: 150000,
    }),
  );
  try {
    for (const label of ["cold", "warm"]) {
      const dir = join(root, label);
      const codexHome = join(dir, "codex-home");
      await mkdir(codexHome, { recursive: true });
      const log = join(dir, "process.jsonl");
      const mock = await startMockResponsesServer([
        {
          kind: "complete",
          text: JSON.stringify({
            summary: "startup diagnostic",
            findings: [],
            testsToAdd: [],
            residualRisks: [],
            openQuestions: [],
          }),
        },
      ]);
      const config = kyosoConfigSchema.parse(defaultConfig);
      config.agents.codex.command = process.execPath;
      config.agents.codex.args = [
        fileURLToPath(import.meta.url),
        "--proxy",
        log,
        command,
        ...config.agents.codex.args,
      ];
      config.agents.codex.provider = "openrouter";
      config.agents.codex.model = "openai/gpt-5.4";
      config.agents.codex.env = {
        ...config.agents.codex.env,
        APP_SERVER_LOGS: join(dir, "app-server"),
        DEFAULT_AUTH_REQUEST: JSON.stringify({
          methodId: "api-key",
          _meta: { "api-key": { apiKey: "dummy-key" } },
        }),
      };
      const manager = new SubprocessAcpAgentManager(
        config,
        {
          PATH: process.env.PATH ?? "",
          HOME: home,
          TMPDIR: root,
          CODEX_HOME: codexHome,
          OPENROUTER_API_KEY: "dummy-key",
        },
        { openRouterBaseUrlForTest: mock.baseUrl },
      );
      const started = performance.now();
      let previousLogLength = 0;
      const printEvents = async () => {
        const contents = await readFile(log, "utf8").catch(() => "");
        if (contents.length !== previousLogLength)
          console.log(
            JSON.stringify({
              label,
              processEvents: contents.slice(previousLogLength),
            }),
          );
        previousLogLength = contents.length;
      };
      const tick = setInterval(() => {
        console.log(
          JSON.stringify({
            label,
            elapsedMs: Math.round(performance.now() - started),
            requests: mock.requests.length,
          }),
        );
        void printEvents();
      }, 10000);
      try {
        const result = await manager.runAgent({
          traceId: "startup-diagnostic",
          agent: "codex",
          role: "combined_reviewer",
          tool: "diff_review",
          prompt:
            "Return the supplied JSON opinion without tools or commentary.",
          workspaceDir: dir,
          timeoutMs: 150000,
          networkMode: "model_only",
        });
        console.log(
          JSON.stringify({
            label,
            elapsedMs: Math.round(performance.now() - started),
            status: result.status,
            error: result.error,
            stopReason: result.stopReason,
            retries: result.observedStreamRetries,
            mockRequestMs: mock.requests.map((request) =>
              Math.round(request.at - started),
            ),
          }),
        );
        if (
          result.status !== "completed" ||
          result.stopReason !== "end_turn" ||
          mock.requests.length !== 1 ||
          result.observedStreamRetries !== 0
        )
          process.exitCode = 1;
        for (let i = 0; i < 30; i++) {
          if (
            (await readFile(log, "utf8").catch(() => "")).includes(
              '"kind":"closed"',
            )
          )
            break;
          await delay(100);
        }
      } finally {
        clearInterval(tick);
        await printEvents();
        await mock.close();
      }
    }
    const npxDir = join(home, ".npm", "_npx");
    for (const cache of await readdir(npxDir).catch(() => [])) {
      for (const pkg of [
        "@agentclientprotocol/codex-acp",
        "@openai/codex",
        "@agentclientprotocol/sdk",
        "zod",
      ]) {
        const contents = await readFile(
          join(npxDir, cache, "node_modules", pkg, "package.json"),
          "utf8",
        ).catch(() => "");
        if (contents)
          console.log(
            JSON.stringify({
              resolvedPackage: pkg,
              version: JSON.parse(contents).version,
            }),
          );
      }
    }
    const npmLogs = join(home, ".npm", "_logs");
    for (const file of await readdir(npmLogs).catch(() => [])) {
      const contents = await readFile(join(npmLogs, file), "utf8");
      const timing = contents
        .split("\n")
        .filter((line) =>
          /^\d+ (http fetch|timing|error|verbose (exit|code))/.test(line),
        );
      console.log(
        JSON.stringify({
          npmLog: file,
          timing: timing.map((line) => sanitizeTextForDisplay(line, 2000)),
        }),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
