import { stderr } from "node:process";
import {
  CODEX_OPENROUTER_PROVIDER,
  type CodexProvider,
} from "../config/schema.js";

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

const CREDENTIAL_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
]);

const CREDENTIAL_LIKE_ENV_KEY_PATTERN =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/i;

const UNEXPANDED_ENV_PLACEHOLDER_PATTERN =
  /^\s*(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%)\s*$/;

const OPENROUTER_EXCLUDED_CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
] as const;

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const KYOSO_OPENROUTER_PROVIDER_ID = "kyoso-openrouter";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_PROVIDER_PRESET = {
  name: "OpenRouter",
  base_url: OPENROUTER_BASE_URL,
  env_key: OPENROUTER_API_KEY_ENV,
  wire_api: "responses",
  requires_openai_auth: false,
} as const;

export class ChildEnvPreflightError extends Error {
  constructor(
    readonly code: "OPENROUTER_KEY_MISSING" | "AGENT_CONFIG_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ChildEnvPreflightError";
  }
}

export function buildChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  whitelist: string[],
  explicit: Record<string, string>,
  options: {
    agent?: "codex" | "claude";
    model?: string;
    provider?: CodexProvider;
    preferApiKey?: boolean;
    onCredentialPlaceholderDiscarded?: (key: string) => void;
    onOpenRouterCredentialWithheld?: (key: string) => void;
    onOpenRouterProvidersDiscarded?: (count: number) => void;
  } = {},
): NodeJS.ProcessEnv {
  if (!parentEnv.PATH) {
    throw new Error("PATH is required to launch ACP child agents.");
  }
  const env: NodeJS.ProcessEnv = {};
  const warnedCredentialPlaceholderKeys = new Set<string>();
  const onCredentialPlaceholderDiscarded = (key: string): void => {
    if (warnedCredentialPlaceholderKeys.has(key)) return;
    warnedCredentialPlaceholderKeys.add(key);
    (
      options.onCredentialPlaceholderDiscarded ??
      warnCredentialPlaceholderDiscarded
    )(key);
  };
  const openRouterSelected =
    options.agent === "codex" && options.provider === CODEX_OPENROUTER_PROVIDER;
  for (const key of MINIMAL_ENV_KEYS) {
    if (parentEnv[key]) env[key] = parentEnv[key];
  }
  for (const key of whitelist) {
    if (key === OPENROUTER_API_KEY_ENV && !openRouterSelected) continue;
    if (
      parentEnv[key] &&
      canCopyEnvValue(key, parentEnv[key], onCredentialPlaceholderDiscarded)
    ) {
      env[key] = parentEnv[key];
    }
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (key === OPENROUTER_API_KEY_ENV && !openRouterSelected) {
      if (value.trim().length > 0) {
        (
          options.onOpenRouterCredentialWithheld ??
          warnOpenRouterCredentialWithheld
        )(key);
      }
      continue;
    }
    if (canCopyEnvValue(key, value, onCredentialPlaceholderDiscarded)) {
      env[key] = value;
    }
  }
  if (openRouterSelected) {
    discardOpenRouterExcludedCredentials(env);
    applyOpenRouterConfig(
      env,
      parentEnv,
      options.model,
      onCredentialPlaceholderDiscarded,
      options.onOpenRouterProvidersDiscarded ??
        warnOpenRouterProvidersDiscarded,
    );
  } else {
    applyModelConfig(env, options.agent, options.model);
  }
  env.KYOSO_CHILD_AGENT = "1";
  if (options.agent === "claude") {
    applyClaudeAuthPreference(env, options.preferApiKey === true);
  }
  return env;
}

function canCopyEnvValue(
  key: string,
  value: string,
  onCredentialPlaceholderDiscarded?: (key: string) => void,
): boolean {
  if (!isUnexpandedCredentialEnvValue(key, value)) return true;
  (onCredentialPlaceholderDiscarded ?? warnCredentialPlaceholderDiscarded)(key);
  return false;
}

function warnCredentialPlaceholderDiscarded(key: string): void {
  stderr.write(
    `kyoso: ignored an unexpanded credential placeholder for ${key}; ensure the client expands it before starting Kyoso.\n`,
  );
}

function warnOpenRouterCredentialWithheld(key: string): void {
  stderr.write(
    `kyoso: ignored explicit ${key} because the OpenRouter provider is not selected for this child.\n`,
  );
}

function warnOpenRouterProvidersDiscarded(count: number): void {
  stderr.write(
    `kyoso: discarded foreign CODEX_CONFIG.model_providers entries: ${count}; provider IDs and configuration values were not displayed.\n`,
  );
}

function discardOpenRouterExcludedCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of OPENROUTER_EXCLUDED_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
}

function applyModelConfig(
  env: NodeJS.ProcessEnv,
  agent: "codex" | "claude" | undefined,
  model: string | undefined,
): void {
  if (!model) return;
  if (agent === "claude" && !env.ANTHROPIC_MODEL) {
    env.ANTHROPIC_MODEL = model;
    return;
  }
  if (agent === "codex" && !env.CODEX_CONFIG) {
    env.CODEX_CONFIG = JSON.stringify({ model });
  }
}

function applyOpenRouterConfig(
  env: NodeJS.ProcessEnv,
  parentEnv: NodeJS.ProcessEnv,
  model: string | undefined,
  onCredentialPlaceholderDiscarded: (key: string) => void,
  onOpenRouterProvidersDiscarded: (count: number) => void,
): void {
  const configuredModel = model?.trim();
  if (!configuredModel) {
    throw new ChildEnvPreflightError(
      "AGENT_CONFIG_INVALID",
      'agents.codex.provider="openrouter" requires a non-empty agents.codex.model.',
    );
  }

  if (!hasEnv(env, OPENROUTER_API_KEY_ENV)) {
    const parentKey = nonEmptyEnv(parentEnv, OPENROUTER_API_KEY_ENV);
    if (parentKey) env[OPENROUTER_API_KEY_ENV] = parentKey;
    else if (
      isUnexpandedCredentialEnvValue(
        OPENROUTER_API_KEY_ENV,
        parentEnv[OPENROUTER_API_KEY_ENV] ?? "",
      )
    ) {
      onCredentialPlaceholderDiscarded(OPENROUTER_API_KEY_ENV);
    }
  }
  if (!hasEnv(env, OPENROUTER_API_KEY_ENV)) {
    throw new ChildEnvPreflightError(
      "OPENROUTER_KEY_MISSING",
      'agents.codex.provider="openrouter" requires OPENROUTER_API_KEY, but it is not visible to the Kyoso process. Add OPENROUTER_API_KEY to the MCP registration, restart the client, then run `kyoso doctor`.',
    );
  }

  const config = parseCodexConfig(env.CODEX_CONFIG);
  assertOpenRouterConfigDoesNotSelectProfile(config);
  if (
    config.model_providers !== undefined &&
    !isPlainObject(config.model_providers)
  ) {
    throw new ChildEnvPreflightError(
      "AGENT_CONFIG_INVALID",
      "CODEX_CONFIG.model_providers must be a JSON object for the OpenRouter provider.",
    );
  }
  reportDiscardedOpenRouterProviders(
    config.model_providers,
    onOpenRouterProvidersDiscarded,
  );

  env.MODEL_PROVIDER = KYOSO_OPENROUTER_PROVIDER_ID;
  env.CODEX_CONFIG = JSON.stringify({
    ...config,
    model: configuredModel,
    model_provider: KYOSO_OPENROUTER_PROVIDER_ID,
    model_providers: {
      [KYOSO_OPENROUTER_PROVIDER_ID]: OPENROUTER_PROVIDER_PRESET,
    },
  });
}

function reportDiscardedOpenRouterProviders(
  modelProviders: unknown,
  onDiscarded: (count: number) => void,
): void {
  if (!isPlainObject(modelProviders)) return;
  const foreignProviderCount = Object.keys(modelProviders).filter(
    (providerId) => providerId !== KYOSO_OPENROUTER_PROVIDER_ID,
  ).length;
  if (foreignProviderCount > 0) onDiscarded(foreignProviderCount);
}

function parseCodexConfig(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ChildEnvPreflightError(
      "AGENT_CONFIG_INVALID",
      "CODEX_CONFIG must contain a JSON object for the OpenRouter provider.",
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ChildEnvPreflightError(
      "AGENT_CONFIG_INVALID",
      "CODEX_CONFIG must contain a JSON object for the OpenRouter provider.",
    );
  }
  return parsed;
}

function assertOpenRouterConfigDoesNotSelectProfile(
  config: Record<string, unknown>,
): void {
  if (Object.hasOwn(config, "profile") || Object.hasOwn(config, "profiles")) {
    throw new ChildEnvPreflightError(
      "AGENT_CONFIG_INVALID",
      "CODEX_CONFIG.profile and CODEX_CONFIG.profiles are not supported for the OpenRouter provider.",
    );
  }
}

function applyClaudeAuthPreference(
  env: NodeJS.ProcessEnv,
  preferApiKey: boolean,
): void {
  discardUnusableEnvValue(env, "ANTHROPIC_API_KEY");
  discardUnusableEnvValue(env, "CLAUDE_CODE_OAUTH_TOKEN");

  const hasApiKey = hasEnv(env, "ANTHROPIC_API_KEY");
  const hasOAuthToken = hasEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
  if (!hasApiKey || !hasOAuthToken) return;
  if (preferApiKey) {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete env.ANTHROPIC_API_KEY;
  }
}

function discardUnusableEnvValue(env: NodeJS.ProcessEnv, key: string): void {
  if (env[key] !== undefined && !hasEnv(env, key)) {
    delete env[key];
  }
}

export function hasUsableEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): boolean {
  return nonEmptyEnv(env, key) !== undefined;
}

export function isUnexpandedEnvPlaceholder(value: string | undefined): boolean {
  return (
    typeof value === "string" && UNEXPANDED_ENV_PLACEHOLDER_PATTERN.test(value)
  );
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return hasUsableEnvValue(env, key);
}

function nonEmptyEnv(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return typeof value === "string" &&
    value.trim().length > 0 &&
    !isUnexpandedCredentialEnvValue(key, value)
    ? value
    : undefined;
}

function isUnexpandedCredentialEnvValue(key: string, value: string): boolean {
  return (
    (CREDENTIAL_ENV_KEYS.has(key) ||
      CREDENTIAL_LIKE_ENV_KEY_PATTERN.test(key)) &&
    isUnexpandedEnvPlaceholder(value)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}
