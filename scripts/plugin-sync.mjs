import {
  assertPluginSkillMirror,
  repositoryRoot,
  syncPluginSkill,
} from "./plugin-distribution.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("Usage: node scripts/plugin-sync.mjs [--check]");
}

if (args[0] === "--check") {
  const result = assertPluginSkillMirror(repositoryRoot);
  console.log(`plugin skill mirror is synchronized: ${result.canonicalDigest}`);
} else {
  const result = syncPluginSkill(repositoryRoot);
  console.log(`plugin skill mirror synchronized: ${result.digest}`);
}
