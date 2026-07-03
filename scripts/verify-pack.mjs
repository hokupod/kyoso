import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
];
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----\\n[^"]+\\n-----END PRIVATE KEY-----\\n?"/,
  /-----BEGIN (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----\r?\n[\s\S]{16,}?\r?\n-----END (?:RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----/,
];

const tempDir = mkdtempSync(join(tmpdir(), "kyoso-pack-"));

try {
  const pack = spawnSync(
    "npm",
    [
      "--cache",
      join(tempDir, "npm-cache"),
      "pack",
      "--json",
      "--pack-destination",
      tempDir,
    ],
    { encoding: "utf8" },
  );

  if (pack.status !== 0) {
    process.stderr.write(pack.stderr);
    process.stderr.write(pack.stdout);
    process.exit(pack.status ?? 1);
  }

  const metadata = parsePackJson(pack.stdout);
  const filePaths = metadata.files.map((file) => file.path);
  const tarballPath = join(tempDir, metadata.filename);
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

  const binFile = metadata.files.find(
    (file) => file.path === "dist/bin/kyoso.js",
  );
  if (!binFile) {
    failures.push("missing CLI bin file: dist/bin/kyoso.js");
  } else if ((binFile.mode & 0o111) === 0) {
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

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`pack verify failed: ${failure}`);
    }
    process.exit(1);
  }

  console.log(
    `pack verify ok: ${metadata.filename} (${filePaths.length} files)`,
  );
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`npm pack did not emit JSON metadata: ${stdout}`);
  }

  const parsed = JSON.parse(stdout.slice(start, end + 1));
  const metadata = parsed[0];
  if (
    typeof metadata?.filename !== "string" ||
    !Array.isArray(metadata.files)
  ) {
    throw new Error("npm pack metadata is missing filename or files.");
  }

  return metadata;
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
