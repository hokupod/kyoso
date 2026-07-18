import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  repositoryRoot,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";
import { assertPublishedCliVersion } from "./plugin-registry.mjs";
import { runMcpPackageRunnerSmoke } from "./mcp-smoke.mjs";

const packageName = "@kyo-so/cli";
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function verifyPublishedCliTarget(
  { packageName: requestedPackageName, packageVersion },
  {
    assertPublished = assertPublishedCliVersion,
    runSmoke = runMcpPackageRunnerSmoke,
  } = {},
) {
  if (requestedPackageName !== packageName) {
    throw new Error(`published CLI package must be ${packageName}`);
  }
  if (!semverPattern.test(packageVersion ?? "")) {
    throw new Error("published CLI version must be a complete SemVer version");
  }

  const requested = await assertPublished({
    packageName: requestedPackageName,
    packageVersion,
  });
  const packageSpecifier = `${requestedPackageName}@${packageVersion}`;
  const mcpArgs = [
    "kyoso",
    "mcp",
    "--ignore-config",
    "--network",
    "model_only",
  ];
  await runSmoke({
    runner: "npx",
    command: "npx",
    args: ["-y", `--package=${packageSpecifier}`, ...mcpArgs],
    expectedVersion: packageVersion,
    published: true,
  });
  await runSmoke({
    runner: "bunx",
    command: "bunx",
    args: ["--package", packageSpecifier, ...mcpArgs],
    expectedVersion: packageVersion,
    published: true,
  });
  return requested;
}

export function parsePublishedCliOptions(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--version") {
    if (!semverPattern.test(args[1])) {
      throw new Error("--version must be a complete SemVer version");
    }
    return { version: args[1] };
  }
  throw new Error(
    "Usage: node scripts/verify-published-cli.mjs [--version COMPLETE_SEMVER]",
  );
}

async function main() {
  const options = parsePublishedCliOptions(process.argv.slice(2));
  const target = options.version
    ? { packageName, packageVersion: options.version }
    : (() => {
        const current = verifyPluginDistribution({
          root: repositoryRoot,
          verifyPackageArchive: false,
        });
        return {
          packageName: current.packageName,
          packageVersion: current.packageVersion,
        };
      })();
  const requested = await verifyPublishedCliTarget(target);
  process.stdout.write(`published CLI verify ok: ${requested}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
