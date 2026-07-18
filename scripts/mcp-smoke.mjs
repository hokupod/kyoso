import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve, sep } from "node:path";

export const KYOSO_PATH_SENTINEL_EXIT_CODE = 97;
export const MCP_SMOKE_EXPECTED_TOOLS = [
  "diff_review",
  "plan_review",
  "security_review",
];

const maxStdoutBytes = 256 * 1024;
const maxStderrBytes = 64 * 1024;
const maxNdjsonLineBytes = 128 * 1024;
const defaultLocalTimeoutMs = 30_000;
const defaultPublishedTimeoutMs = 120_000;
const sentinelMarkerEnv = "KYOSO_MCP_SMOKE_SENTINEL_MARKER";
const allowedAdditionalEnvironment = new Set([
  "CI",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_offline",
  "NPM_CONFIG_OFFLINE",
]);
const copiedEnvironment = [
  "CI",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
];
const windowsEnvironment = [
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
];

export function buildMcpHandshakeInput() {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "kyoso-mcp-smoke", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  return `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
}

export function assertMcpHandshake(output, expected) {
  const expectedName = expected?.name ?? "kyoso";
  const expectedVersion = expected?.version;
  const expectedTools = expected?.tools ?? MCP_SMOKE_EXPECTED_TOOLS;
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    throw new Error("MCP smoke expected a non-empty exact server version");
  }

  const responses = [];
  for (const line of String(output).split("\n")) {
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > maxNdjsonLineBytes) {
      throw new Error("MCP stdout contains an oversized NDJSON line");
    }
    try {
      responses.push(JSON.parse(line));
    } catch {
      throw new Error(
        `MCP stdout contains non-JSON NDJSON: ${line.slice(0, 200)}`,
      );
    }
  }

  const initialize = responseForId(responses, 1);
  if (initialize.error) {
    throw new Error(
      `MCP initialize returned an error: ${JSON.stringify(initialize.error)}`,
    );
  }
  const serverInfo = initialize.result?.serverInfo;
  if (serverInfo?.name !== expectedName) {
    throw new Error(
      `unexpected MCP server name: ${String(serverInfo?.name)}; expected ${expectedName}`,
    );
  }
  if (serverInfo.version !== expectedVersion) {
    throw new Error(
      `MCP server version ${String(serverInfo.version)} does not match expected ${expectedVersion}`,
    );
  }

  const toolsResponse = responseForId(responses, 2);
  if (toolsResponse.error) {
    throw new Error(
      `MCP tools/list returned an error: ${JSON.stringify(toolsResponse.error)}`,
    );
  }
  const toolNames = toolsResponse.result?.tools?.map((tool) => tool?.name);
  if (!Array.isArray(toolNames) || !toolNames.every(isNonEmptyString)) {
    throw new Error("MCP tools/list returned an invalid tools payload");
  }
  if (!sameExactStringSet(toolNames, expectedTools)) {
    throw new Error(
      `unexpected MCP tools: ${toolNames.join(", ")}; expected ${expectedTools.join(", ")}`,
    );
  }

  return { serverInfo, toolNames };
}

export function createKyosoPathSentinel(options = {}) {
  const root = options.root ?? options.directory;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("Kyoso PATH sentinel requires a directory");
  }
  const platform = options.platform ?? process.platform;
  const sentinelDirectory = join(root, "kyoso-path-sentinel");
  const markerPath =
    options.markerPath ?? join(root, "kyoso-path-sentinel.marker");
  mkdirSync(sentinelDirectory, { recursive: true });
  rmSync(markerPath, { force: true });

  const programPath = join(sentinelDirectory, "kyoso-sentinel.mjs");
  writeFileSync(
    programPath,
    [
      'import { writeFileSync } from "node:fs";',
      `const marker = process.env.${sentinelMarkerEnv};`,
      'if (!marker) throw new Error("missing sentinel marker path");',
      'writeFileSync(marker, "ambient kyoso invocation\\n", "utf8");',
      `process.exit(${KYOSO_PATH_SENTINEL_EXIT_CODE});`,
      "",
    ].join("\n"),
    "utf8",
  );

  if (platform === "win32") {
    writeFileSync(
      join(sentinelDirectory, "kyoso.cmd"),
      '@echo off\r\nnode "%~dp0kyoso-sentinel.mjs"\r\n',
      "utf8",
    );
  } else {
    const commandPath = join(sentinelDirectory, "kyoso");
    writeFileSync(
      commandPath,
      '#!/bin/sh\nexec node "$(dirname "$0")/kyoso-sentinel.mjs"\n',
      "utf8",
    );
    chmodSync(commandPath, 0o755);
  }

  return {
    directory: sentinelDirectory,
    markerPath,
    exitCode: KYOSO_PATH_SENTINEL_EXIT_CODE,
  };
}

export function buildMcpSmokeEnvironment(options) {
  const root = options?.root;
  const sentinel = options?.sentinel;
  const sourceEnv = options?.sourceEnv ?? process.env;
  const platform = options?.platform ?? process.platform;
  if (!root || !sentinel?.directory || !sentinel?.markerPath) {
    throw new Error("MCP smoke environment requires a root and PATH sentinel");
  }
  if (!isNonEmptyString(sourceEnv.PATH)) {
    throw new Error("MCP smoke environment requires PATH");
  }
  const home = sourceEnv.HOME ?? sourceEnv.USERPROFILE;
  if (!isNonEmptyString(home)) {
    throw new Error("MCP smoke environment requires HOME");
  }

  const directories = {
    tmp: join(root, "tmp"),
    npmCache: join(root, "npm-cache"),
    bunCache: join(root, "bun-cache"),
    xdgCache: join(root, "xdg-cache"),
    xdgConfig: join(root, "xdg-config"),
    codexHome: join(root, "codex-home"),
  };
  for (const directory of Object.values(directories)) {
    mkdirSync(directory, { recursive: true });
  }
  const npmUserConfig = join(root, "npmrc");
  const npmGlobalConfig = join(root, "npm-globalrc");
  writeFileSync(
    npmUserConfig,
    "registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n",
    "utf8",
  );
  writeFileSync(npmGlobalConfig, "", "utf8");

  const env = {
    PATH: `${sentinel.directory}${delimiter}${sourceEnv.PATH}`,
    HOME: home,
    TMPDIR: directories.tmp,
    TMP: directories.tmp,
    TEMP: directories.tmp,
    CODEX_HOME: directories.codexHome,
    XDG_CACHE_HOME: directories.xdgCache,
    XDG_CONFIG_HOME: directories.xdgConfig,
    BUN_INSTALL_CACHE_DIR: directories.bunCache,
    // Bun's environment override has precedence over global bunfig settings,
    // including scoped registry resolution, while preserving HOME for safe-chain.
    BUN_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    npm_config_cache: directories.npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_globalconfig: npmGlobalConfig,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_update_notifier: "false",
    NPM_CONFIG_CACHE: directories.npmCache,
    NPM_CONFIG_USERCONFIG: npmUserConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    [sentinelMarkerEnv]: sentinel.markerPath,
  };
  for (const key of copiedEnvironment) {
    if (isNonEmptyString(sourceEnv[key])) env[key] = sourceEnv[key];
  }
  if (platform === "win32") {
    for (const key of windowsEnvironment) {
      if (isNonEmptyString(sourceEnv[key])) env[key] = sourceEnv[key];
    }
  }
  for (const [key, value] of Object.entries(options?.extraEnv ?? {})) {
    if (!allowedAdditionalEnvironment.has(key)) {
      throw new Error(
        `MCP smoke does not allow additional environment variable: ${key}`,
      );
    }
    if (!isNonEmptyString(value)) {
      throw new Error(
        `MCP smoke additional environment variable must be non-empty: ${key}`,
      );
    }
    env[key] = value;
  }
  return { env, directories };
}

export async function runMcpPackageRunnerSmoke(options) {
  const command = options?.command;
  const args = options?.args;
  if (
    !isNonEmptyString(command) ||
    !Array.isArray(args) ||
    !args.every(isNonEmptyString)
  ) {
    throw new Error(
      "MCP package-runner smoke requires a command and argv array",
    );
  }
  const sourceEnv = options.sourceEnv ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs =
    options.timeoutMs ??
    (options.published ? defaultPublishedTimeoutMs : defaultLocalTimeoutMs);
  const deadline = createSmokeDeadline(timeoutMs);
  const root = mkdtempSync(
    join(options.tempParent ?? tmpdir(), "kyoso-mcp-smoke-"),
  );
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const sentinel = createKyosoPathSentinel({ root, platform });
  const { env, directories } = buildMcpSmokeEnvironment({
    root,
    sentinel,
    sourceEnv,
    platform,
    extraEnv: options.extraEnv,
  });
  options.onTempRoot?.(root);

  try {
    const prepared =
      (await deadline.run("runner preparation", () =>
        options.prepare?.({
          root,
          workspace,
          env,
          directories,
          sentinel,
          timeoutMs: deadline.remaining("runner preparation"),
        }),
      )) ?? {};
    const target = {
      command: prepared.command ?? command,
      args: prepared.args ?? args,
      cwd: prepared.cwd ?? workspace,
    };
    if (
      sourceEnv.CI === "true" &&
      (options.runner === "npx" || options.runner === "bunx")
    ) {
      assertRunnerUsesSafeChainShim({
        command: target.command,
        env,
        platform,
        dependencies: options.dependencies,
      });
    }

    const baseline = await runBoundedProcess({
      command: "kyoso",
      args: [],
      cwd: target.cwd,
      env,
      timeoutMs: Math.min(deadline.remaining("PATH sentinel baseline"), 10_000),
      platform,
      dependencies: options.dependencies,
    });
    if (
      baseline.exitCode !== KYOSO_PATH_SENTINEL_EXIT_CODE ||
      !existsSync(sentinel.markerPath)
    ) {
      throw new Error(
        `PATH sentinel baseline failed: expected kyoso exit ${KYOSO_PATH_SENTINEL_EXIT_CODE} with marker`,
      );
    }
    unlinkSync(sentinel.markerPath);

    return await runMcpCommandSmoke({
      command: target.command,
      args: target.args,
      cwd: target.cwd,
      env,
      expectedVersion: options.expectedVersion,
      expectedName: options.expectedName,
      expectedTools: options.expectedTools,
      timeoutMs: deadline.remaining("MCP command"),
      sentinel,
      platform,
      dependencies: options.dependencies,
      allowStderr:
        options.runner === "bunx" ? isBunxInstallProgress : undefined,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function createSmokeDeadline(timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = (stage) => {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `MCP package-runner smoke timed out after ${timeoutMs}ms during ${stage}`,
      );
    }
    return remainingMs;
  };
  return {
    remaining,
    async run(stage, operation) {
      const remainingMs = remaining(stage);
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new Error(
                  `MCP package-runner smoke timed out after ${timeoutMs}ms during ${stage}`,
                ),
              );
            }, remainingMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export async function runMcpCommandSmoke(options) {
  const result = await runBoundedProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    input: buildMcpHandshakeInput(),
    timeoutMs: options.timeoutMs ?? defaultLocalTimeoutMs,
    platform: options.platform ?? process.platform,
    dependencies: options.dependencies,
  });
  const sentinel = options.sentinel;
  if (
    result.exitCode === KYOSO_PATH_SENTINEL_EXIT_CODE ||
    (sentinel && existsSync(sentinel.markerPath))
  ) {
    throw new Error("ambient kyoso fallback detected by PATH sentinel");
  }
  if (result.signal) {
    throw new Error(`MCP command was terminated by ${result.signal}`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `MCP command exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  if (
    result.stderr.trim().length > 0 &&
    !options.allowStderr?.(result.stderr)
  ) {
    throw new Error(
      `MCP command wrote stderr: ${result.stderr.trim().slice(0, 400)}`,
    );
  }
  const handshake = assertMcpHandshake(result.stdout, {
    name: options.expectedName,
    version: options.expectedVersion,
    tools: options.expectedTools,
  });
  return { ...result, ...handshake };
}

export function assertRunnerUsesSafeChainShim({
  command,
  env,
  platform = process.platform,
  dependencies = {},
}) {
  const resolveExecutable =
    dependencies.resolveExecutable ?? defaultResolveExecutable;
  const getSafeChainInstallDir =
    dependencies.getSafeChainInstallDir ?? defaultSafeChainInstallDir;
  const lstatPath = dependencies.lstatPath ?? lstatSync;
  const realpathPath = dependencies.realpathPath ?? realpathSync;
  const runnerPath = resolveExecutable(command, env.PATH, platform, env);
  if (!runnerPath) {
    throw new Error(`safe-chain CI check could not resolve ${command}`);
  }
  const installDir = getSafeChainInstallDir(env);
  const shimDirectory = resolve(installDir, "shims");
  const shimStats = lstatPath(shimDirectory);
  if (!shimStats.isDirectory() || shimStats.isSymbolicLink()) {
    throw new Error(
      `safe-chain CI check requires a non-symlink shims directory: ${shimDirectory}`,
    );
  }
  const runnerStats = lstatPath(runnerPath);
  if (!runnerStats.isFile() || runnerStats.isSymbolicLink()) {
    throw new Error(
      `safe-chain CI check requires a non-symlink runner under ${shimDirectory}; resolved ${runnerPath}`,
    );
  }
  const resolvedShimDirectory = realpathPath(shimDirectory);
  const resolvedRunner = realpathPath(runnerPath);
  const relativeRunner = relative(resolvedShimDirectory, resolvedRunner);
  if (
    relativeRunner === "" ||
    relativeRunner === ".." ||
    relativeRunner.startsWith(`..${sep}`) ||
    relativeRunner.includes(`${sep}..${sep}`)
  ) {
    throw new Error(
      `safe-chain CI check requires ${command} under ${resolvedShimDirectory}; resolved ${resolvedRunner}`,
    );
  }
}

function defaultResolveExecutable(command, pathValue, platform, env) {
  const names =
    platform === "win32" ? executableNames(command, env) : [command];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function executableNames(command, env) {
  const suffixes = env.PATHEXT?.split(";").filter(Boolean) ?? [
    ".COM",
    ".EXE",
    ".BAT",
    ".CMD",
  ];
  return [
    command,
    ...suffixes.map((suffix) => `${command}${suffix.toLowerCase()}`),
  ];
}

function defaultSafeChainInstallDir(env) {
  const result = spawnSync("safe-chain", ["get-install-dir"], {
    encoding: "utf8",
    env,
    timeout: 10_000,
  });
  if (
    result.error ||
    result.status !== 0 ||
    result.stdout.trim().length === 0
  ) {
    throw new Error(
      `safe-chain CI check could not resolve its install directory: ${(result.error?.message ?? result.stderr ?? "unknown error").trim()}`,
    );
  }
  return result.stdout.trim();
}

function runBoundedProcess(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const spawnProcess = options.dependencies?.spawnProcess ?? spawn;
    const terminate =
      options.dependencies?.terminateProcessTree ?? terminateProcessTree;
    let child;
    let settled = false;
    let failure;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLineBytes = 0;
    let timeout;

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback(value);
    };
    const fail = (error) => {
      if (failure || settled) return;
      failure = error;
      let termination;
      try {
        termination = child?.pid
          ? Promise.resolve(terminate(child, options.platform))
          : Promise.resolve();
      } catch (terminationError) {
        termination = Promise.reject(terminationError);
      }
      termination.then(
        () => settle(rejectPromise, failure),
        (terminationError) => settle(rejectPromise, terminationError),
      );
    };

    try {
      child = spawnProcess(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: options.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      settle(rejectPromise, error);
      return;
    }

    timeout = setTimeout(() => {
      fail(new Error(`MCP command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    timeout.unref?.();

    child.on("error", (error) => fail(error));
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutBytes += Buffer.byteLength(text, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        fail(new Error(`MCP stdout exceeded ${maxStdoutBytes} bytes`));
        return;
      }
      const parts = text.split("\n");
      for (const [index, part] of parts.entries()) {
        stdoutLineBytes += Buffer.byteLength(part, "utf8");
        if (stdoutLineBytes > maxNdjsonLineBytes) {
          fail(
            new Error(`MCP NDJSON line exceeded ${maxNdjsonLineBytes} bytes`),
          );
          return;
        }
        if (index < parts.length - 1) stdoutLineBytes = 0;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrBytes += Buffer.byteLength(text, "utf8");
      if (stderrBytes > maxStderrBytes) {
        fail(new Error(`MCP stderr exceeded ${maxStderrBytes} bytes`));
        return;
      }
      stderr += text;
    });
    child.stdin.on("error", (error) => {
      fail(error);
    });
    child.on("close", (exitCode, signal) => {
      if (failure) return;
      if (
        options.platform !== "win32" &&
        child?.pid &&
        isProcessGroupAlive(child.pid)
      ) {
        fail(new Error("MCP command exited with live descendant processes"));
        return;
      }
      settle(resolvePromise, { exitCode, signal, stdout, stderr });
    });

    try {
      child.stdin.end(options.input ?? "");
    } catch (error) {
      fail(error);
    }
  });
}

async function terminateProcessTree(child, platform) {
  if (!child.pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  signalProcessTree(child, "SIGTERM");
  await waitForProcessGroupExit(child.pid, 500);
  if (!isProcessGroupAlive(child.pid)) return;
  signalProcessTree(child, "SIGKILL");
  await waitForProcessGroupExit(child.pid, 500);
}

function signalProcessTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForProcessGroupExit(pid, timeoutMs) {
  return new Promise((resolvePromise) => {
    let interval;
    let timeout;
    const finish = () => {
      clearInterval(interval);
      clearTimeout(timeout);
      resolvePromise();
    };
    if (!isProcessGroupAlive(pid)) {
      finish();
      return;
    }
    interval = setInterval(() => {
      if (!isProcessGroupAlive(pid)) finish();
    }, 25);
    timeout = setTimeout(finish, timeoutMs);
  });
}

function responseForId(responses, id) {
  const response = responses.find((item) => item?.id === id);
  if (!response) throw new Error(`missing MCP response ${id}`);
  return response;
}

function sameExactStringSet(left, right) {
  if (left.length !== right.length || new Set(left).size !== left.length) {
    return false;
  }
  return [...left]
    .sort()
    .every((value, index) => value === [...right].sort()[index]);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isBunxInstallProgress(stderr) {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length > 0 &&
    lines.every((line) =>
      /^(Resolving dependencies|Resolved, downloaded and extracted \[\d+\]|Saved lockfile)$/.test(
        line,
      ),
    )
  );
}
