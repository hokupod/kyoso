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
  options: { agent?: "codex" | "claude"; preferApiKey?: boolean } = {},
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
  if (options.agent === "claude") {
    applyClaudeAuthPreference(env, options.preferApiKey === true);
  }
  return env;
}

function applyClaudeAuthPreference(
  env: NodeJS.ProcessEnv,
  preferApiKey: boolean,
): void {
  const hasApiKey = hasEnv(env, "ANTHROPIC_API_KEY");
  const hasOAuthToken = hasEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
  if (!hasApiKey || !hasOAuthToken) return;
  if (preferApiKey) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}
