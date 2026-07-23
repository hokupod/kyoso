import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
// @ts-expect-error The smoke harness is intentionally shipped as a standalone Node.js script.
import * as mcpSmoke from "../../scripts/mcp-smoke.mjs";

const {
  assertMcpHandshake,
  assertRunnerUsesSafeChainShim,
  buildMcpHandshakeInput,
  buildMcpSmokeEnvironment,
  createKyosoPathSentinel,
  runMcpPackageRunnerSmoke,
} = mcpSmoke;

const version = "0.13.1";
const sourceEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/tmp/kyoso-home",
};

describe("MCP smoke harness", () => {
  test("builds the initialize, initialized, and tools/list handshake", () => {
    const requests = buildMcpHandshakeInput()
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));

    expect(requests).toEqual([
      expect.objectContaining({ id: 1, method: "initialize" }),
      expect.objectContaining({ method: "notifications/initialized" }),
      expect.objectContaining({ id: 2, method: "tools/list" }),
    ]);
  });

  test("accepts a valid exact MCP handshake", () => {
    const result = assertMcpHandshake(validResponses(), { version });

    expect(result.serverInfo).toEqual({ name: "kyoso", version });
    expect(result.toolNames).toEqual([
      "security_review",
      "diff_review",
      "plan_review",
    ]);
  });

  test.each([
    [
      "wrong server name",
      validResponses().replace('"name":"kyoso"', '"name":"other"'),
      "unexpected MCP server name",
    ],
    [
      "wrong server version",
      validResponses().replace(`"version":"${version}"`, '"version":"0.0.0"'),
      "does not match expected",
    ],
    [
      "missing tool",
      validResponses().replace(',{"name":"plan_review"}', ""),
      "unexpected MCP tools",
    ],
    [
      "extra tool",
      validResponses().replace('"tools":[', '"tools":[{"name":"extra"},'),
      "unexpected MCP tools",
    ],
    ["malformed NDJSON", "not-json\n", "non-JSON NDJSON"],
  ])("rejects %s", (_name, output, message) => {
    expect(() => assertMcpHandshake(output, { version })).toThrow(message);
  });

  test("proves the bare kyoso PATH sentinel before accepting an explicit runner", async () => {
    const result = await runMcpPackageRunnerSmoke({
      command: process.execPath,
      args: ["--input-type=module", "--eval", fakeMcpServerProgram()],
      expectedVersion: version,
      sourceEnv,
    });

    expect(result.serverInfo).toEqual({ name: "kyoso", version });
  });

  test("rejects a runner that falls back to ambient kyoso", async () => {
    await expect(
      runMcpPackageRunnerSmoke({
        command: "kyoso",
        args: ["mcp", "--ignore-config", "--network", "model_only"],
        expectedVersion: version,
        sourceEnv,
      }),
    ).rejects.toThrow("ambient kyoso fallback detected");
  });

  test("permits only Bun's fixed install progress on runner stderr", async () => {
    await expect(
      runMcpPackageRunnerSmoke({
        runner: "bunx",
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          fakeMcpServerProgram({
            beforeResponse:
              'process.stderr.write("Resolving dependencies\\nResolved, downloaded and extracted [3]\\nSaved lockfile\\n");',
          }),
        ],
        expectedVersion: version,
        sourceEnv,
      }),
    ).resolves.toMatchObject({ serverInfo: { name: "kyoso", version } });

    await expect(
      runMcpPackageRunnerSmoke({
        runner: "bunx",
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          fakeMcpServerProgram({
            beforeResponse:
              'process.stderr.write("unexpected server stderr\\n");',
          }),
        ],
        expectedVersion: version,
        sourceEnv,
      }),
    ).rejects.toThrow("MCP command wrote stderr");
  });

  test("terminates timeout descendants and cleans its temporary root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "kyoso-mcp-smoke-test-"));
    const childPidPath = join(outside, "child.pid");
    let timeoutRoot = "";
    let outputRoot = "";

    try {
      await expect(
        runMcpPackageRunnerSmoke({
          command: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            [
              'import { spawn } from "node:child_process";',
              'import { writeFileSync } from "node:fs";',
              `const child = spawn(process.execPath, ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
              `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");`,
              "setInterval(() => {}, 1000);",
            ].join("\n"),
          ],
          expectedVersion: version,
          sourceEnv,
          timeoutMs: 500,
          onTempRoot: (root: string) => {
            timeoutRoot = root;
          },
        }),
      ).rejects.toThrow("timed out");

      const childPid = Number(await readFile(childPidPath, "utf8"));
      await wait(200);
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(existsSync(timeoutRoot)).toBe(false);

      await expect(
        runMcpPackageRunnerSmoke({
          command: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            'process.stdout.write(("x".repeat(1024) + "\\n").repeat(300)); setInterval(() => {}, 1000);',
          ],
          expectedVersion: version,
          sourceEnv,
          timeoutMs: 5_000,
          onTempRoot: (root: string) => {
            outputRoot = root;
          },
        }),
      ).rejects.toThrow("stdout exceeded");
      expect(existsSync(outputRoot)).toBe(false);
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  if (process.platform !== "win32") {
    test("rejects successful runners that leave detached descendants", async () => {
      const outside = await mkdtemp(join(tmpdir(), "kyoso-mcp-descendant-"));
      const childPidPath = join(outside, "child.pid");
      let tempRoot = "";

      try {
        await expect(
          runMcpPackageRunnerSmoke({
            command: process.execPath,
            args: [
              "--input-type=module",
              "--eval",
              mcpServerWithDetachedDescendant(childPidPath),
            ],
            expectedVersion: version,
            sourceEnv,
            onTempRoot: (root: string) => {
              tempRoot = root;
            },
          }),
        ).rejects.toThrow("exited with live descendant processes");

        const childPid = Number(await readFile(childPidPath, "utf8"));
        await wait(200);
        expect(() => process.kill(childPid, 0)).toThrow();
        expect(existsSync(tempRoot)).toBe(false);
      } finally {
        await rm(outside, { force: true, recursive: true });
      }
    });
  }

  test("does not forward credential or NODE_PATH state into the child", async () => {
    const outside = await mkdtemp(join(tmpdir(), "kyoso-mcp-smoke-env-"));
    const observedPath = join(outside, "environment.json");

    try {
      await runMcpPackageRunnerSmoke({
        command: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          fakeMcpServerProgram({
            beforeResponse: `writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({ openai: process.env.OPENAI_API_KEY, nodePath: process.env.NODE_PATH, codexHome: process.env.CODEX_HOME }), "utf8");`,
          }),
        ],
        expectedVersion: version,
        sourceEnv: {
          ...sourceEnv,
          OPENAI_API_KEY: "should-not-reach-child",
          NODE_PATH: "/unsafe/node-path",
        },
      });

      expect(JSON.parse(await readFile(observedPath, "utf8"))).toEqual({
        codexHome: expect.stringContaining("codex-home"),
      });
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("bounds asynchronous preparation by the smoke deadline", async () => {
    let timeoutRoot = "";

    await expect(
      runMcpPackageRunnerSmoke({
        command: process.execPath,
        args: ["--eval", "process.exit(0)"],
        expectedVersion: version,
        sourceEnv,
        timeoutMs: 100,
        prepare: () => new Promise(() => {}),
        onTempRoot: (root: string) => {
          timeoutRoot = root;
        },
      }),
    ).rejects.toThrow("timed out after 100ms during runner preparation");

    expect(existsSync(timeoutRoot)).toBe(false);
  });

  test("gives the MCP command only the deadline remaining after preparation", async () => {
    await expect(
      runMcpPackageRunnerSmoke({
        command: process.execPath,
        args: ["--input-type=module", "--eval", delayedMcpServerProgram(1_700)],
        expectedVersion: version,
        sourceEnv,
        timeoutMs: 2_500,
        prepare: async () => {
          await wait(1_000);
        },
      }),
    ).rejects.toThrow("MCP command timed out");
  });

  test("waits for custom tree termination before rejecting", async () => {
    let terminationFinished = false;

    await expect(
      runMcpPackageRunnerSmoke({
        command: process.execPath,
        args: ["--eval", "setInterval(() => {}, 1000)"],
        expectedVersion: version,
        sourceEnv,
        timeoutMs: 250,
        dependencies: {
          terminateProcessTree: (child: { kill: (signal: string) => void }) =>
            new Promise<void>((resolve) => {
              child.kill("SIGTERM");
              setTimeout(() => {
                terminationFinished = true;
                resolve();
              }, 50);
            }),
        },
      }),
    ).rejects.toThrow("timed out");

    expect(terminationFinished).toBe(true);
  });

  test("reports an early stdin EPIPE and cleans the smoke root", async () => {
    let tempRoot = "";
    let spawnCount = 0;

    await expect(
      runMcpPackageRunnerSmoke({
        command: "npx",
        args: ["--package=@kyo-so/cli@0.13.1", "kyoso"],
        expectedVersion: version,
        sourceEnv,
        onTempRoot: (root: string) => {
          tempRoot = root;
        },
        dependencies: {
          spawnProcess: (
            _command: string,
            _args: string[],
            options: { env: Record<string, string> },
          ) => {
            spawnCount += 1;
            const child = new EventEmitter();
            const stdin = new EventEmitter() as EventEmitter & {
              end: (input?: string) => void;
            };
            Object.assign(child, {
              pid: 12_345,
              stdin,
              stdout: new EventEmitter(),
              stderr: new EventEmitter(),
            });
            stdin.end = () => {
              queueMicrotask(() => {
                if (spawnCount === 1) {
                  const markerPath =
                    options.env.KYOSO_MCP_SMOKE_SENTINEL_MARKER;
                  if (!markerPath) {
                    throw new Error("missing fake PATH sentinel marker");
                  }
                  writeFileSync(markerPath, "baseline\n", "utf8");
                  child.emit("close", 97, null);
                  return;
                }
                stdin.emit("error", new Error("stdin EPIPE"));
                child.emit("close", 1, null);
              });
            };
            return child;
          },
          terminateProcessTree: () => undefined,
        },
      }),
    ).rejects.toThrow("stdin EPIPE");

    expect(existsSync(tempRoot)).toBe(false);
  });

  test("keeps HOME for safe-chain while pinning Bun's registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "kyoso-mcp-smoke-ci-"));
    try {
      const sentinel = createKyosoPathSentinel({ root });
      const { env } = buildMcpSmokeEnvironment({
        root,
        sentinel,
        sourceEnv: {
          ...sourceEnv,
          HOME: "/safe-chain-home",
          BUN_CONFIG_REGISTRY: "http://unsafe-registry.invalid/",
        },
      });

      expect(env.HOME).toBe("/safe-chain-home");
      expect(env.BUN_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
      expect(() =>
        assertRunnerUsesSafeChainShim({
          command: "npx",
          env,
          dependencies: {
            resolveExecutable: () => "/usr/local/bin/npx",
            getSafeChainInstallDir: () => "/safe-chain",
            lstatPath: (path: string) => safeChainStats(path),
            realpathPath: (path: string) => path,
          },
        }),
      ).toThrow("requires npx under");
      expect(() =>
        assertRunnerUsesSafeChainShim({
          command: "npx",
          env,
          dependencies: {
            resolveExecutable: () => "/safe-chain/shims/npx",
            getSafeChainInstallDir: () => "/safe-chain",
            lstatPath: (path: string) => safeChainStats(path),
            realpathPath: (path: string) => path,
          },
        }),
      ).not.toThrow();
      expect(() =>
        assertRunnerUsesSafeChainShim({
          command: "npx",
          env,
          dependencies: {
            resolveExecutable: () => "/safe-chain/shims/npx",
            getSafeChainInstallDir: () => "/safe-chain",
            lstatPath: (path: string) => safeChainStats(path, true),
            realpathPath: (path: string) => path,
          },
        }),
      ).toThrow("requires a non-symlink runner");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("accepts npm-installed safe-chain setup-ci shims under HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "kyoso-safe-chain-npm-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const shims = join(home, ".safe-chain", "shims");
      const server = join(root, "fake-mcp-server.mjs");
      mkdirSync(bin, { recursive: true });
      mkdirSync(shims, { recursive: true });
      const safeChain = join(bin, "safe-chain");
      const ambientNpx = join(bin, "npx");
      const npx = join(shims, "npx");
      writeFileSync(
        safeChain,
        '#!/bin/sh\necho "Install directory is only available for packaged safe-chain binaries." >&2\nexit 1\n',
        "utf8",
      );
      writeFileSync(ambientNpx, "#!/bin/sh\nexit 66\n", "utf8");
      writeFileSync(server, fakeMcpServerProgram(), "utf8");
      writeFileSync(
        npx,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}\n`,
        "utf8",
      );
      chmodSync(safeChain, 0o755);
      chmodSync(ambientNpx, 0o755);
      chmodSync(npx, 0o755);
      const env = {
        PATH: `${bin}${delimiter}${sourceEnv.PATH}`,
        HOME: home,
        CI: "true",
      };

      expect(assertRunnerUsesSafeChainShim({ command: "npx", env })).toBe(
        realpathSync(npx),
      );
      const result = await runMcpPackageRunnerSmoke({
        runner: "npx",
        command: "npx",
        args: ["--package=@kyo-so/cli@0.13.1", "kyoso", "mcp"],
        expectedVersion: version,
        sourceEnv: env,
        requireSafeChainInCi: true,
      });
      expect(result).toMatchObject({ serverInfo: { name: "kyoso", version } });

      writeFileSync(
        safeChain,
        '#!/bin/sh\necho "unexpected install-dir failure" >&2\nexit 1\n',
        "utf8",
      );
      expect(() =>
        assertRunnerUsesSafeChainShim({ command: "npx", env }),
      ).toThrow("unexpected install-dir failure");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function validResponses() {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "kyoso", version } },
    },
    {
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: [
          { name: "security_review" },
          { name: "diff_review" },
          { name: "plan_review" },
        ],
      },
    },
  ]
    .map((response) => JSON.stringify(response))
    .join("\n");
}

function fakeMcpServerProgram(options: { beforeResponse?: string } = {}) {
  return [
    'import { writeFileSync } from "node:fs";',
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    options.beforeResponse ?? "",
    "  const responses = [",
    `    { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "kyoso", version: ${JSON.stringify(version)} } } },`,
    '    { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "security_review" }, { name: "diff_review" }, { name: "plan_review" }] } },',
    "  ];",
    '  process.stdout.write(responses.map((response) => JSON.stringify(response)).join("\\n") + "\\n");',
    "});",
  ].join("\n");
}

function delayedMcpServerProgram(delayMs: number) {
  return [
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    `  setTimeout(() => process.stdout.write(${JSON.stringify(`${validResponses()}\n`)}), ${delayMs});`,
    "});",
  ].join("\n");
}

function mcpServerWithDetachedDescendant(childPidPath: string) {
  return [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `const child = spawn(process.execPath, ["--eval", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
    "child.unref();",
    `writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid), "utf8");`,
    "process.stdin.resume();",
    'process.stdin.on("end", () => {',
    `  process.stdout.write(${JSON.stringify(`${validResponses()}\n`)});`,
    "});",
  ].join("\n");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function safeChainStats(path: string, symlinkRunner = false) {
  return {
    isDirectory: () => path === "/safe-chain/shims",
    isFile: () => path !== "/safe-chain/shims",
    isSymbolicLink: () => symlinkRunner && path === "/safe-chain/shims/npx",
  };
}
