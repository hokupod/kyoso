import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  boundedProbeTimeoutMs,
  remainingProbeTimeoutMs,
  waitForFileUntilDeadline,
} from "./plugin-runtime-deadline.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_NPX_INSTALL_TIMEOUT_MS = 180_000;
const CODEX_COMMAND_TIMEOUT_MS = 60_000;
const PROBE_WALL_TIME_MS = 300_000;
const probeDeadlineAtEpochMs = Date.now() + PROBE_WALL_TIME_MS;
const probeNpmCache = process.env.KYOSO_PLUGIN_RUNTIME_NPM_CACHE
  ? resolve(process.env.KYOSO_PLUGIN_RUNTIME_NPM_CACHE)
  : undefined;
const options = parseOptions(process.argv.slice(2));
const codexVersion =
  options.codexVersion ?? process.env.CODEX_VERSION ?? "0.144.1";
const probeRoot = mkdtempSync(join(tmpdir(), "kyoso-plugin-runtime-"));
const marketplaceRoot = join(probeRoot, "marketplace");
const home = join(probeRoot, "home");
const codexHome = join(probeRoot, "codex-home");
const workspace = join(probeRoot, "workspace");
const tempDirectory = join(probeRoot, "tmp");
const pathSentinel = join(probeRoot, "path-sentinel");
const observationPath = join(probeRoot, "mcp-observation.json");
const configPath = join(codexHome, "config.toml");
const fakeSecrets = {
  OPENAI_API_KEY: "kyoso-probe-openai",
  CODEX_API_KEY: "kyoso-probe-codex-api",
  CODEX_ACCESS_TOKEN: "kyoso-probe-codex-access",
  OPENROUTER_API_KEY: "kyoso-probe-openrouter",
  ANTHROPIC_API_KEY: "kyoso-probe-anthropic",
  CLAUDE_CODE_OAUTH_TOKEN: "kyoso-probe-claude-oauth",
};
const deniedSentinel = "kyoso-probe-denied";

for (const path of [
  marketplaceRoot,
  home,
  codexHome,
  workspace,
  tempDirectory,
  pathSentinel,
]) {
  mkdirSync(path, { recursive: true });
}

try {
  prepareFixture();
  const result = await runProbe();

  if (options.recordPath) {
    updateCompatibilityRecord(resolve(options.recordPath), result);
  }
  if (options.expectPath) {
    assertCompatibilityRecord(resolve(options.expectPath), result);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  if (!options.keep) {
    rmSync(probeRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`plugin runtime probe kept at ${probeRoot}\n`);
  }
}

async function runProbe() {
  const versionOutput = runCodex(["--version"], {
    timeoutMs: CODEX_NPX_INSTALL_TIMEOUT_MS,
  }).stdout.trim();
  const marketplaceAdd = runCodexJson([
    "plugin",
    "marketplace",
    "add",
    marketplaceRoot,
    "--json",
  ]);
  const marketplaceList = runCodexJson([
    "plugin",
    "marketplace",
    "list",
    "--json",
  ]);
  const beforeAdd = pluginEntry(
    runCodexJson([
      "plugin",
      "list",
      "--marketplace",
      "kyoso",
      "--available",
      "--json",
    ]),
  );
  const install = runCodexJson(["plugin", "add", "kyoso@kyoso", "--json"]);
  const afterAdd = pluginEntry(
    runCodexJson(["plugin", "list", "--marketplace", "kyoso", "--json"]),
  );
  const defaultMcp = mcpEntry(runCodexJson(["mcp", "list", "--json"]));
  const appServerStatus = await runAppServerProbe({ expectMcpLaunch: true });
  const observation = readJson(observationPath);

  setPluginEnabled(false);
  const disabledPlugin = pluginEntry(
    runCodexJson(["plugin", "list", "--marketplace", "kyoso", "--json"]),
  );
  setPluginEnabled(true);

  appendConfig('[plugins."kyoso@kyoso".mcp_servers.kyoso]\nenabled = false\n');
  const pluginOverride = mcpEntry(runCodexJson(["mcp", "list", "--json"]));
  rmSync(observationPath, { force: true });
  const disabledAppServerStatus = await runAppServerProbe({
    expectMcpLaunch: false,
  });
  const disabledMcpStarted = existsSync(observationPath);

  appendConfig(
    '[mcp_servers.kyoso]\ncommand = "manual-kyoso"\nargs = ["mcp"]\nenabled = true\n',
  );
  const manualOverride = mcpEntry(runCodexJson(["mcp", "list", "--json"]));

  const remove = runCodexJson(["plugin", "remove", "kyoso@kyoso", "--json"]);
  const afterRemove = pluginEntry(
    runCodexJson([
      "plugin",
      "list",
      "--marketplace",
      "kyoso",
      "--available",
      "--json",
    ]),
  );

  return {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString().slice(0, 10),
    codexVersion: versionOutput.replace(/^codex-cli\s+/, ""),
    os: { platform: platform(), release: release(), arch: arch() },
    fixtureSchemaVersion: 1,
    contract: {
      distribution: summarizeDistributionFixture(),
      marketplace: {
        name: marketplaceAdd.marketplaceName,
        listed: marketplaceList.marketplaces?.some(
          (marketplace) => marketplace.name === "kyoso",
        ),
        pluginId: beforeAdd.pluginId,
        selector: "kyoso@kyoso",
        installPolicy: beforeAdd.installPolicy,
        authPolicy: beforeAdd.authPolicy,
      },
      transitions: {
        beforeAdd: pluginState(beforeAdd),
        afterAdd: pluginState(afterAdd),
        disabled: pluginState(disabledPlugin),
        afterRemove: pluginState(afterRemove),
        installPluginId: install.pluginId,
        removePluginId: remove.pluginId,
      },
      mcp: {
        default: summarizeMcp(defaultMcp),
        pluginOverride: summarizeMcp(pluginOverride),
        manualOverride: summarizeMcp(manualOverride),
      },
      appServer: {
        default: summarizeAppServerStatus(appServerStatus),
        pluginOverride: {
          ...summarizeAppServerStatus(disabledAppServerStatus),
          mcpObservationWritten: disabledMcpStarted,
        },
      },
      environment: summarizeEnvironment(observation),
      isolation: {
        distinctHomeAndCodexHome: home !== codexHome,
        distinctWorkspace: workspace !== home && workspace !== codexHome,
      },
    },
  };
}

function prepareFixture() {
  cpSync(
    join(repositoryRoot, ".agents", "plugins"),
    join(marketplaceRoot, ".agents", "plugins"),
    { recursive: true },
  );
  cpSync(join(repositoryRoot, "plugins"), join(marketplaceRoot, "plugins"), {
    recursive: true,
  });

  const mcpPath = join(
    marketplaceRoot,
    "plugins",
    "kyoso",
    ".codex-plugin",
    "mcp.json",
  );
  const mcp = readJson(mcpPath);
  mcp.kyoso.command = process.execPath;
  mcp.kyoso.args = [
    join(
      repositoryRoot,
      "test",
      "fixtures",
      "plugin-runtime",
      "probe-server.mjs",
    ),
    observationPath,
  ];
  writeJson(mcpPath, mcp);
}

function runCodex(args, runOptions = {}) {
  const timeoutMs = boundedProbeTimeoutMs(
    probeDeadlineAtEpochMs,
    runOptions.timeoutMs ?? CODEX_COMMAND_TIMEOUT_MS,
  );
  const result = spawnSync(
    "npx",
    ["-y", `@openai/codex@${codexVersion}`, ...args],
    {
      cwd: runOptions.cwd ?? workspace,
      env: probeEnvironment(),
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `codex ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function runCodexJson(args) {
  const result = runCodex(args);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `codex ${args.join(" ")} returned invalid JSON: ${error.message}\n${result.stdout}`,
    );
  }
}

async function runAppServerProbe(options) {
  const child = spawn(
    "npx",
    [
      "-y",
      `@openai/codex@${codexVersion}`,
      "app-server",
      "--listen",
      "stdio://",
    ],
    {
      cwd: workspace,
      env: probeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const responses = new Map();
  const waiters = new Map();
  let stdoutBuffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline === -1) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      if (message.id === undefined) continue;
      responses.set(message.id, message);
      waiters.get(message.id)?.();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "kyoso-plugin-runtime-probe", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
    await responseFor(1);
    send({
      id: 2,
      method: "mcpServerStatus/list",
      params: { detail: "full" },
    });
    const mcpStatus = await responseFor(2, 30_000);
    send({
      id: 3,
      method: "skills/list",
      params: { cwds: [workspace], forceReload: true },
    });
    const skills = await responseFor(3, 30_000);
    if (options.expectMcpLaunch) {
      await waitForFileUntilDeadline(
        observationPath,
        Math.min(probeDeadlineAtEpochMs, Date.now() + 10_000),
        {
          timeoutMessage: `MCP observation was not written: ${observationPath}`,
        },
      );
    } else {
      await delay(boundedProbeTimeoutMs(probeDeadlineAtEpochMs, 1_000));
    }
    return { mcpStatus: mcpStatus.result, skills: skills.result };
  } finally {
    await terminateChild(child, probeDeadlineAtEpochMs);
  }

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async function responseFor(id, timeoutMs = 20_000) {
    if (!responses.has(id)) {
      await withTimeout(
        new Promise((resolveResponse) => waiters.set(id, resolveResponse)),
        boundedProbeTimeoutMs(probeDeadlineAtEpochMs, timeoutMs),
        `app-server response ${id} timed out: ${stderr}`,
      );
    }
    const response = responses.get(id);
    if (response?.error) {
      throw new Error(
        `app-server response ${id} failed: ${JSON.stringify(response.error)}`,
      );
    }
    return response;
  }
}

async function terminateChild(child, deadlineAtEpochMs) {
  child.stdin.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const gracefulWaitMs = remainingProbeTimeoutMs(deadlineAtEpochMs, 2_000);
  if (gracefulWaitMs > 0 && (await waitForChildExit(child, gracefulWaitMs))) {
    return;
  }
  child.kill("SIGKILL");
  const forceWaitMs = remainingProbeTimeoutMs(deadlineAtEpochMs, 2_000);
  if (forceWaitMs > 0) {
    await waitForChildExit(child, forceWaitMs);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    let settled = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);

    function finish(exited) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolveExit(exited);
    }
  });
}

function probeEnvironment() {
  return {
    ...process.env,
    ...fakeSecrets,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: tempDirectory,
    PATH: [
      pathSentinel,
      dirname(process.execPath),
      process.env.PATH ?? "",
    ].join(delimiter),
    KYOSO_PROBE_DENIED_SENTINEL: deniedSentinel,
    npm_config_cache: probeNpmCache ?? join(probeRoot, "npm-cache"),
    npm_config_update_notifier: "false",
  };
}

function setPluginEnabled(enabled) {
  const current = readFileSync(configPath, "utf8");
  const next = current.replace(
    /(\[plugins\."kyoso@kyoso"\]\nenabled = )(?:true|false)/,
    `$1${enabled}`,
  );
  if (next === current) {
    throw new Error("installed plugin enabled setting was not found");
  }
  writeFileSync(configPath, next, "utf8");
}

function appendConfig(content) {
  const current = readFileSync(configPath, "utf8");
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  writeFileSync(configPath, `${current}${separator}${content}`, "utf8");
}

function pluginEntry(result) {
  const entries = [...(result.installed ?? []), ...(result.available ?? [])];
  const entry = entries.find(
    (candidate) => candidate.pluginId === "kyoso@kyoso",
  );
  if (!entry)
    throw new Error("kyoso@kyoso was not present in plugin list JSON");
  return entry;
}

function summarizeDistributionFixture() {
  const manifest = readJson(
    join(repositoryRoot, "plugins", "kyoso", ".codex-plugin", "plugin.json"),
  );
  const mcp = readJson(
    join(repositoryRoot, "plugins", "kyoso", ".codex-plugin", "mcp.json"),
  );
  const packageArgument = mcp.kyoso.args.find((argument) =>
    argument.startsWith("--package="),
  );
  if (!packageArgument) {
    throw new Error("Plugin MCP package argument was not found");
  }
  return {
    pluginVersion: manifest.version,
    mcpCommand: mcp.kyoso.command,
    mcpPackagePin: packageArgument.slice("--package=".length),
  };
}

function mcpEntry(result) {
  const entry = result.find((candidate) => candidate.name === "kyoso");
  if (!entry) throw new Error("kyoso was not present in mcp list JSON");
  return entry;
}

function pluginState(entry) {
  return { installed: entry.installed, enabled: entry.enabled };
}

function summarizeMcp(entry) {
  return {
    enabled: entry.enabled,
    command:
      entry.transport.command === process.execPath
        ? "$NODE"
        : entry.transport.command,
    args:
      entry.transport.command === process.execPath
        ? ["$PROBE_SERVER", "$OBSERVATION"]
        : entry.transport.args,
    envVars: entry.transport.env_vars,
    cwd: entry.transport.cwd,
    startupTimeoutSec: entry.startup_timeout_sec,
    toolTimeoutSec: entry.tool_timeout_sec,
  };
}

function summarizeAppServerStatus(result) {
  const server = result.mcpStatus?.data?.find(
    (entry) => entry.name === "kyoso",
  );
  const skill = result.skills?.data
    ?.flatMap((entry) => entry.skills ?? [])
    .find((entry) => entry.name === "kyoso-review");
  return {
    serverFound: Boolean(server),
    toolNames: Object.keys(server?.tools ?? {}).sort(),
    authStatus: server?.authStatus ?? null,
    skillFound: Boolean(skill),
    skillEnabled: skill?.enabled ?? null,
    skillHasKyosoMcpDependency:
      skill?.dependencies?.tools?.some(
        (dependency) =>
          dependency.type === "mcp" && dependency.value === "kyoso",
      ) ?? false,
  };
}

function summarizeEnvironment(observation) {
  const observedEnv = observation.env ?? {};
  return {
    cwdIsWorkspace: observation.cwd === realpathSync(workspace),
    homeInherited: observedEnv.HOME === home,
    codexHomeForwarded: observedEnv.CODEX_HOME === codexHome,
    tempDirectoryInherited: observedEnv.TMPDIR === tempDirectory,
    pathInherited: observedEnv.PATH?.split(delimiter).includes(pathSentinel),
    allowlistedEnvForwarded: Object.fromEntries(
      Object.entries(fakeSecrets).map(([key, value]) => [
        key,
        observedEnv[key] === value,
      ]),
    ),
    deniedSentinelForwarded:
      observedEnv.KYOSO_PROBE_DENIED_SENTINEL === deniedSentinel,
  };
}

function updateCompatibilityRecord(path, result) {
  const record = existsSync(path)
    ? readJson(path)
    : {
        schemaVersion: 1,
        minimumSupportedCodexVersion: result.codexVersion,
        expectedContract: result.contract,
        probes: [],
      };
  if (!isDeepStrictEqual(record.expectedContract, result.contract)) {
    throw new Error(
      `Codex ${result.codexVersion} runtime contract differs from the recorded contract`,
    );
  }
  const probes = record.probes.filter(
    (probe) => probe.codexVersion !== result.codexVersion,
  );
  probes.push({
    codexVersion: result.codexVersion,
    verifiedAt: result.verifiedAt,
    os: result.os,
    fixtureSchemaVersion: result.fixtureSchemaVersion,
  });
  probes.sort((left, right) =>
    left.codexVersion.localeCompare(right.codexVersion),
  );
  writeJson(path, { ...record, probes });
}

function assertCompatibilityRecord(path, result) {
  const record = readJson(path);
  const expected = record.probes?.find(
    (probe) => probe.codexVersion === result.codexVersion,
  );
  if (!expected) {
    throw new Error(
      `compatibility record has no probe for Codex ${result.codexVersion}`,
    );
  }
  if (!isDeepStrictEqual(record.expectedContract, result.contract)) {
    throw new Error(
      `Codex ${result.codexVersion} runtime contract differs from the compatibility record`,
    );
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseOptions(args) {
  const parsed = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (
      item === "--codex-version" ||
      item === "--record" ||
      item === "--expect"
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${item} requires a value`);
      index += 1;
      if (item === "--codex-version") parsed.codexVersion = value;
      if (item === "--record") parsed.recordPath = value;
      if (item === "--expect") parsed.expectPath = value;
      continue;
    }
    throw new Error(`unknown option: ${item}`);
  }
  return parsed;
}
