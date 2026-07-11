import {
  repositoryRoot,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";

const options = parseOptions(process.argv.slice(2));

const result = verifyPluginDistribution({
  root: repositoryRoot,
  verifyPackageArchive: !options.skipPack,
  expectedPackageVersion: options.expectedPackageVersion,
});
console.log(
  `plugin verify ok: ${result.pluginId} ${result.packageName}@${result.packageVersion}`,
);

function parseOptions(args) {
  const options = { skipPack: false, expectedPackageVersion: undefined };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--skip-pack") {
      options.skipPack = true;
      continue;
    }
    if (argument === "--expect-package-version") {
      const version = args[index + 1];
      if (!version) {
        throw new Error("--expect-package-version requires a version");
      }
      options.expectedPackageVersion = version;
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: node scripts/verify-plugin.mjs [--skip-pack] [--expect-package-version VERSION]",
    );
  }
  return options;
}
