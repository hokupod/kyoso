import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requiredPrefixes = ["dist/", ".agents/skills/kyoso-review/", "examples/"];
const requiredFiles = ["README.md", "LICENSE", "package.json"];
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
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to read ${entry}`);
  }

  return result.stdout;
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
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "kyoso-pack-verify", version: "0.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];
  const run = spawnSync(
    "node",
    [binPath, "mcp", "--ignore-config", "--network", "model_only"],
    {
      cwd: extractDir,
      env: {
        ...process.env,
        OPENAI_API_KEY: "",
        CODEX_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      },
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const stderr = (run.stderr ?? "").trim();
  const stderrNote = stderr
    ? `stderr: ${stderr.slice(0, 400)}`
    : "no stderr output";
  if (run.error) {
    throw new Error(
      `failed to run packed MCP server: ${run.error.message}; ${stderrNote}`,
    );
  }
  if (run.signal) {
    throw new Error(
      `packed MCP server was killed by ${run.signal} (likely timeout); ${stderrNote}`,
    );
  }

  const responses = [];
  const parseErrors = [];
  for (const line of (run.stdout ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      responses.push(JSON.parse(line));
    } catch {
      parseErrors.push(line);
    }
  }
  const findResponse = (id) => {
    const response = responses.find((item) => item.id === id);
    if (!response) {
      throw new Error(
        `missing MCP response ${id}; exit=${run.status}; ${stderrNote}`,
      );
    }
    return response;
  };

  const initialize = findResponse(1);
  const serverInfo = initialize.result?.serverInfo;
  if (serverInfo?.name !== "kyoso") {
    throw new Error(`unexpected MCP server name: ${serverInfo?.name}`);
  }
  if (serverInfo.version !== packageVersion) {
    throw new Error(
      `MCP server version ${serverInfo.version} does not match package.json version ${packageVersion}`,
    );
  }

  const tools = findResponse(2);
  const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
  const expected = ["plan_review", "security_review", "diff_review"];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected MCP tools: ${names.join(", ")}`);
  }
  if (parseErrors.length > 0) {
    throw new Error(`non-JSON stdout from MCP server: ${parseErrors[0]}`);
  }
  if (stderr.length > 0) {
    throw new Error(`unexpected MCP stderr: ${stderr}`);
  }

  verifyPackedSkillOnlySetup(binPath, tempDir, packageVersion);
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
