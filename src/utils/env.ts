const MINIMAL_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "USER",
  "USERNAME",
  "SystemRoot",
];

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  whitelist: string[],
  explicit: Record<string, string>,
): NodeJS.ProcessEnv {
  if (!parentEnv.PATH) {
    throw new Error("PATH is required to launch ACP child agents.");
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of MINIMAL_ENV_KEYS) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  for (const key of whitelist) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  for (const [key, value] of Object.entries(explicit)) {
    env[key] = value;
  }
  env.KYOSO_CHILD_AGENT = "1";
  return env;
}
