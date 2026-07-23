import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  assertMcpHandshake,
  buildMcpHandshakeInput,
  buildMcpSmokeEnvironment,
  createKyosoPathSentinel,
  runMcpPackageRunnerSmoke,
} from "./mcp-smoke.mjs";

const requiredPrefixes = ["dist/", ".agents/skills/kyoso-review/", "examples/"];
const requiredFiles = [
  "README.md",
  "LICENSE",
  "package.json",
  "scripts/review-budget-report.mjs",
];
const forbiddenPrefixes = [
  "src/",
  "ai/",
  ".kyoso/",
  ".claude/",
  "node_modules/",
  "test/",
  ".github/",
  "plugins/",
  ".agents/plugins/",
  ".claude-plugin/",
];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----\\n[^"]+\\n-----END PRIVATE KEY-----\\n?"/,
  /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----\r?\n[\s\S]{16,}?\r?\n-----END (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/,
];

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
const kyosoVersion = readFileSync("src/core/constants.ts", "utf8").match(
  /KYOSO_VERSION = "([^"]+)"/,
)?.[1];
if (kyosoVersion !== packageVersion) {
  console.error(
    `pack verify failed: KYOSO_VERSION (${kyosoVersion}) does not match package.json version (${packageVersion})`,
  );
  process.exit(1);
}

const tempDir = mkdtempSync(join(tmpdir(), "kyoso-pack-"));

try {
  // npm's stdout is unreliable under interposing shims (safe-chain in CI
  // interleaves its own output with --json payloads), so derive everything
  // from the packed archive itself instead of parsing pack metadata.
  const archiveDir = join(tempDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  const pack = spawnSync(
    "npm",
    [
      "--cache",
      join(tempDir, "npm-cache"),
      "pack",
      "--pack-destination",
      archiveDir,
    ],
    { encoding: "utf8" },
  );

  if (pack.status !== 0) {
    process.stderr.write(pack.stderr);
    process.stderr.write(pack.stdout);
    process.exit(pack.status ?? 1);
  }

  const archives = readdirSync(archiveDir).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    console.error(
      `pack verify failed: npm pack produced ${archives.length} archives; expected exactly 1`,
    );
    process.exit(1);
  }
  const tarballPath = join(archiveDir, archives[0]);
  const packageEntries = listTarEntriesVerbose(tarballPath);
  const filePaths = packageEntries.map((entry) => entry.path);
  const failures = [];

  for (const prefix of requiredPrefixes) {
    if (!filePaths.some((path) => path.startsWith(prefix))) {
      failures.push(`missing required package prefix: ${prefix}`);
    }
  }

  for (const file of requiredFiles) {
    if (!filePaths.includes(file)) {
      failures.push(`missing required package file: ${file}`);
    }
  }

  const binFile = packageEntries.find(
    (entry) => entry.path === "dist/bin/kyoso.js",
  );
  if (!binFile) {
    failures.push("missing CLI bin file: dist/bin/kyoso.js");
  } else if (!/x/.test(binFile.mode)) {
    failures.push("CLI bin file is not executable: dist/bin/kyoso.js");
  }

  const budgetReportBinFile = packageEntries.find(
    (entry) => entry.path === "scripts/review-budget-report.mjs",
  );
  if (!budgetReportBinFile) {
    failures.push(
      "missing budget-report bin file: scripts/review-budget-report.mjs",
    );
  } else if (!/x/.test(budgetReportBinFile.mode)) {
    failures.push(
      "budget-report bin file is not executable: scripts/review-budget-report.mjs",
    );
  }

  for (const prefix of forbiddenPrefixes) {
    if (filePaths.some((path) => path.startsWith(prefix))) {
      failures.push(`forbidden package prefix included: ${prefix}`);
    }
  }

  const tarEntries = listTarEntries(tarballPath);
  const binContent = readTarEntry(tarballPath, "package/dist/bin/kyoso.js");
  if (!binContent.startsWith("#!/usr/bin/env node\n")) {
    failures.push("CLI bin file is missing the Node shebang.");
  }
  const budgetReportBinContent = readTarEntry(
    tarballPath,
    "package/scripts/review-budget-report.mjs",
  );
  if (!budgetReportBinContent.startsWith("#!/usr/bin/env node\n")) {
    failures.push("budget-report bin file is missing the Node shebang.");
  }
  const packedManifest = JSON.parse(
    readTarEntry(tarballPath, "package/package.json"),
  );
  if (packedManifest.name !== "@kyo-so/cli") {
    failures.push("package manifest name must be @kyo-so/cli.");
  }
  if (packedManifest.bin?.kyoso !== "dist/bin/kyoso.js") {
    failures.push("package manifest is missing the kyoso bin.");
  }
  if (
    packedManifest.bin?.["kyoso-budget-report"] !==
    "scripts/review-budget-report.mjs"
  ) {
    failures.push("package manifest is missing the kyoso-budget-report bin.");
  }
  if (
    !packedManifest.bin ||
    typeof packedManifest.bin !== "object" ||
    Object.keys(packedManifest.bin).length < 2
  ) {
    failures.push("package manifest must retain at least two bin entries.");
  }

  for (const entry of tarEntries) {
    const content = readTarEntry(tarballPath, entry);
    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        failures.push(`possible secret-like value in package entry: ${entry}`);
      }
    }
  }

  if (failures.length === 0) {
    try {
      verifyPackedMcpServer(tarballPath, tempDir, packageVersion);
    } catch (error) {
      failures.push(
        `packed MCP smoke failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length === 0) {
    try {
      verifyPackedBudgetReport(tarballPath, tempDir);
    } catch (error) {
      failures.push(
        `packed budget-report smoke failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length === 0) {
    try {
      await verifyLocalPackageRunnerSmokes(
        tarballPath,
        tempDir,
        packedManifest,
      );
    } catch (error) {
      failures.push(
        `local package-runner MCP smoke failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`pack verify failed: ${failure}`);
    }
    process.exit(1);
  }

  console.log(`pack verify ok: ${archives[0]} (${filePaths.length} files)`);
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

// Parse `tar -tvf` lines (mode is the first column, the entry name the last
// whitespace-separated field) and strip the leading "package/" prefix so
// callers see npm-pack-style relative paths.
function listTarEntriesVerbose(tarballPath) {
  const result = spawnSync("tar", ["-tvf", tarballPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to list ${tarballPath}`);
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const fields = line.split(/\s+/);
      const name = fields[fields.length - 1];
      return { mode: fields[0], path: name.replace(/^package\//, "") };
    })
    .filter((entry) => entry.path.length > 0 && !entry.path.endsWith("/"));
}

function listTarEntries(tarballPath) {
  const result = spawnSync("tar", ["-tf", tarballPath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to list ${tarballPath}`);
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readTarEntry(tarballPath, entry) {
  const result = spawnSync("tar", ["-xOf", tarballPath, entry], {
    encoding: "utf8",
    // The bundled CLI passed 10 MiB in 2026-07; keep ample headroom so the
    // shebang/manifest checks never fail on artifact size alone.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to read ${entry}`);
  }

  return result.stdout;
}

function verifyPackedBudgetReport(tarballPath, tempDir) {
  const extractDir = join(tempDir, "budget-report-extract");
  mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync("tar", ["-xf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || "failed to extract budget report");
  }

  const traceDir = join(tempDir, "budget-report-traces");
  mkdirSync(traceDir, { recursive: true });
  writeFileSync(
    join(traceDir, "trace.jsonl"),
    `${JSON.stringify({
      type: "model_call_completed",
      traceId: "tr_pack_verify",
      kind: "primary",
      agent: "codex",
      resultStatus: "completed",
      messageBytes: 10,
      thoughtBytes: 20,
      outputBytes: 30,
      usage: { totalTokens: 12 },
      executionIdentity: {
        providerRoute: "codex_default",
        reportingStatus: "unknown",
      },
    })}\n`,
    "utf8",
  );
  const binPath = join(
    extractDir,
    "package",
    "scripts",
    "review-budget-report.mjs",
  );
  const run = spawnSync("node", [binPath, "--trace-dir", traceDir, "--json"], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(run.stderr || `budget report exited ${run.status}`);
  }
  if (run.stdout.trim().length === 0) {
    throw new Error(
      `budget report returned no output${run.stderr ? `; stderr: ${run.stderr.trim()}` : ""}`,
    );
  }
  const report = JSON.parse(run.stdout);
  if (
    report.source?.jsonlFiles !== 1 ||
    report.calls?.completed !== 1 ||
    report.calls?.normalPath !== 1 ||
    report.bytes?.normalPath?.outputBytes?.p99 !== 30
  ) {
    throw new Error("packed budget report returned an unexpected schema");
  }
}

// One-shot spawnSync on purpose: an async spawn() issued after the many
// spawnSync() calls above can leave the child stuck in dyld on macOS.
// The MCP stdio server answers each request and exits on stdin EOF.
function verifyPackedMcpServer(tarballPath, tempDir, packageVersion) {
  const extractDir = join(tempDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync("tar", ["-xf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || "failed to extract package tarball");
  }

  const binPath = join(extractDir, "package", "dist", "bin", "kyoso.js");
  const smokeRoot = join(tempDir, "direct-mcp-smoke");
  const sentinel = createKyosoPathSentinel({ root: smokeRoot });
  const { env } = buildMcpSmokeEnvironment({ root: smokeRoot, sentinel });
  const run = spawnSync(
    process.execPath,
    [binPath, "mcp", "--ignore-config", "--network", "model_only"],
    {
      cwd: extractDir,
      env,
      input: buildMcpHandshakeInput(),
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const stderr = (run.stderr ?? "").trim();
  if (run.error) {
    throw new Error(
      `failed to run packed MCP server: ${run.error.message}${stderr ? `; stderr: ${stderr.slice(0, 400)}` : ""}`,
    );
  }
  if (run.signal) {
    throw new Error(
      `packed MCP server was killed by ${run.signal}${stderr ? `; stderr: ${stderr.slice(0, 400)}` : ""}`,
    );
  }
  if (run.status !== 0) {
    throw new Error(
      `packed MCP server exited ${String(run.status)}${stderr ? `; stderr: ${stderr.slice(0, 400)}` : ""}`,
    );
  }
  if (stderr.length > 0) {
    throw new Error(`unexpected MCP stderr: ${stderr.slice(0, 400)}`);
  }
  assertMcpHandshake(run.stdout ?? "", {
    version: packageVersion,
  });

  verifyPackedSkillOnlySetup(binPath, tempDir, packageVersion);
}

async function verifyLocalPackageRunnerSmokes(
  tarballPath,
  tempDir,
  packedManifest,
) {
  const runnerProbeTarball = createRunnerProbeTarball(
    tarballPath,
    tempDir,
    packedManifest,
  );
  const localSpec = `file:${runnerProbeTarball}`;
  const mcpArgs = [
    "kyoso",
    "mcp",
    "--ignore-config",
    "--network",
    "model_only",
  ];

  await runMcpPackageRunnerSmoke({
    runner: "npx",
    command: "npx",
    args: ["-y", `--package=${localSpec}`, ...mcpArgs],
    expectedVersion: packedManifest.version,
    requireSafeChainInCi: true,
    extraEnv: { npm_config_offline: "true" },
  });

  await runMcpPackageRunnerSmoke({
    runner: "bunx",
    command: "bunx",
    args: ["--no-install", "--package", packedManifest.name, ...mcpArgs],
    expectedVersion: packedManifest.version,
    requireSafeChainInCi: true,
    prepare: ({ root, workspace, env, timeoutMs }) => {
      const consumer = join(workspace, "bun-consumer");
      mkdirSync(consumer, { recursive: true });
      writeFileSync(
        join(consumer, "package.json"),
        `${JSON.stringify(
          {
            name: "kyoso-local-runner-consumer",
            private: true,
            type: "module",
            dependencies: { [packedManifest.name]: localSpec },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      const install = spawnSync(
        "bun",
        ["install", "--offline", "--ignore-scripts"],
        {
          cwd: consumer,
          env,
          encoding: "utf8",
          timeout: timeoutMs,
        },
      );
      if (install.error || install.status !== 0) {
        throw new Error(
          `offline Bun install failed: ${(install.error?.message ?? install.stderr ?? install.stdout ?? "unknown error").trim()}`,
        );
      }
      assertBunLocalConsumer(consumer, packedManifest, runnerProbeTarball);
      return { cwd: consumer };
    },
  });
}

function createRunnerProbeTarball(tarballPath, tempDir, packedManifest) {
  const extractDir = join(tempDir, "runner-probe-extract");
  const packageDir = join(tempDir, "runner-probe-package");
  const archiveDir = join(tempDir, "runner-probe-archive");
  mkdirSync(extractDir, { recursive: true });
  const extract = spawnSync("tar", ["-xf", tarballPath, "-C", extractDir], {
    encoding: "utf8",
  });
  if (extract.status !== 0) {
    throw new Error(extract.stderr || "failed to extract runner-probe source");
  }

  const packedRoot = join(extractDir, "package");
  cpSync(join(packedRoot, "dist"), join(packageDir, "dist"), {
    recursive: true,
  });
  mkdirSync(join(packageDir, "scripts"), { recursive: true });
  cpSync(
    join(packedRoot, "scripts", "review-budget-report.mjs"),
    join(packageDir, "scripts", "review-budget-report.mjs"),
  );
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packedManifest.name,
        version: packedManifest.version,
        type: packedManifest.type,
        engines: packedManifest.engines,
        bin: packedManifest.bin,
        dependencies: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  mkdirSync(archiveDir, { recursive: true });
  const pack = spawnSync(
    "npm",
    [
      "--cache",
      join(tempDir, "runner-probe-npm-cache"),
      "pack",
      "--pack-destination",
      archiveDir,
    ],
    { cwd: packageDir, encoding: "utf8", timeout: 30_000 },
  );
  if (pack.error || pack.status !== 0) {
    throw new Error(
      `failed to create runner-probe tarball: ${(pack.error?.message ?? pack.stderr ?? pack.stdout ?? "unknown error").trim()}`,
    );
  }
  const archives = readdirSync(archiveDir).filter((name) =>
    name.endsWith(".tgz"),
  );
  if (archives.length !== 1) {
    throw new Error(
      `runner-probe pack produced ${archives.length} archives; expected exactly 1`,
    );
  }
  const runnerProbeTarball = realpathSync(join(archiveDir, archives[0]));
  const runnerManifest = JSON.parse(
    readTarEntry(runnerProbeTarball, "package/package.json"),
  );
  if (
    runnerManifest.name !== packedManifest.name ||
    runnerManifest.version !== packedManifest.version ||
    runnerManifest.type !== packedManifest.type ||
    JSON.stringify(runnerManifest.engines) !==
      JSON.stringify(packedManifest.engines) ||
    JSON.stringify(runnerManifest.bin) !== JSON.stringify(packedManifest.bin) ||
    Object.keys(runnerManifest.bin ?? {}).length < 2 ||
    Object.keys(runnerManifest.dependencies ?? {}).length !== 0
  ) {
    throw new Error(
      "runner-probe package manifest does not preserve the local 2-bin contract",
    );
  }
  return runnerProbeTarball;
}

function assertBunLocalConsumer(consumer, packedManifest, runnerProbeTarball) {
  const installed = join(consumer, "node_modules", "@kyo-so", "cli");
  if (!existsSync(installed)) {
    throw new Error(
      "offline Bun install did not resolve the local runner-probe package",
    );
  }
  const installedRealPath = realpathSync(installed);
  const installedBinRealPath = realpathSync(
    join(installed, "dist", "bin", "kyoso.js"),
  );
  if (!installedBinRealPath.startsWith(`${installedRealPath}${sep}`)) {
    throw new Error(
      "offline Bun install resolved kyoso outside its local package",
    );
  }
  const installedManifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  if (
    installedManifest.name !== packedManifest.name ||
    installedManifest.version !== packedManifest.version ||
    installedManifest.bin?.kyoso !== "dist/bin/kyoso.js" ||
    installedManifest.bin?.["kyoso-budget-report"] !==
      "scripts/review-budget-report.mjs" ||
    Object.keys(installedManifest.bin ?? {}).length < 2
  ) {
    throw new Error("offline Bun install lost the runner-probe 2-bin manifest");
  }
  const lockPath = join(consumer, "bun.lock");
  if (!existsSync(lockPath)) {
    throw new Error("offline Bun install did not produce bun.lock");
  }
  const lock = readFileSync(lockPath, "utf8");
  if (!lock.includes("file:") || !lock.includes(runnerProbeTarball)) {
    throw new Error(
      "bun.lock does not retain the local runner-probe file spec",
    );
  }
}

function verifyPackedSkillOnlySetup(binPath, tempDir, packageVersion) {
  const workspace = join(tempDir, "skill-workspace");
  const home = join(tempDir, "skill-home");
  const codexHome = join(tempDir, "skill-codex-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const configPath = join(codexHome, "config.toml");
  const existingConfig = "malformed config [[";
  writeFileSync(configPath, existingConfig, "utf8");

  const run = spawnSync(
    "node",
    [binPath, "setup", "codex", "--write", "--skill-only"],
    {
      cwd: workspace,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (run.error) {
    throw new Error(`packed Skill-only setup failed: ${run.error.message}`);
  }
  if (run.status !== 0) {
    throw new Error(
      `packed Skill-only setup exited ${run.status}: ${run.stderr || run.stdout}`,
    );
  }
  if (!run.stdout.includes("Codex skill: created")) {
    throw new Error(
      `packed Skill-only setup did not create the Skill: ${run.stdout}`,
    );
  }
  if (run.stdout.includes("Codex MCP")) {
    throw new Error("packed Skill-only setup unexpectedly ran an MCP step");
  }

  const skillDir = join(workspace, ".agents", "skills", "kyoso-review");
  const markerPath = join(skillDir, ".kyoso-install.json");
  const metadataPath = join(skillDir, "agents", "openai.yaml");
  if (!existsSync(join(skillDir, "SKILL.md")) || !existsSync(metadataPath)) {
    throw new Error("packed Skill-only setup omitted canonical Skill files");
  }
  if (readFileSync(metadataPath, "utf8").includes("dependencies:")) {
    throw new Error(
      "packed Skill-only setup unexpectedly included a Plugin MCP dependency",
    );
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  if (
    marker.installer !== "@kyo-so/cli" ||
    marker.cliVersion !== packageVersion ||
    !/^sha256:[0-9a-f]{64}$/.test(marker.digest)
  ) {
    throw new Error("packed Skill-only setup wrote an invalid install marker");
  }
  if (readFileSync(configPath, "utf8") !== existingConfig) {
    throw new Error("packed Skill-only setup changed Codex MCP configuration");
  }
  if (existsSync(join(home, ".codex", "config.toml"))) {
    throw new Error("packed Skill-only setup created fallback Codex config");
  }
}
