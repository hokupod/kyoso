import {
  repositoryRoot,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";
import { assertPublishedCliVersion } from "./plugin-registry.mjs";

if (process.argv.length !== 2) {
  throw new Error("Usage: node scripts/verify-plugin-registry.mjs");
}

const plugin = verifyPluginDistribution({ root: repositoryRoot });
const requested = assertPublishedCliVersion({
  cwd: repositoryRoot,
  packageName: plugin.packageName,
  packageVersion: plugin.packageVersion,
});

console.log(`plugin registry verify ok: ${requested}`);
