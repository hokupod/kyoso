import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubprocessAcpAgentManager } from "../acp/AcpAgentProcess.js";
import { defaultConfig } from "../config/defaultConfig.js";
import {
  CODEX_OPENROUTER_PROVIDER,
  kyosoConfigSchema,
  type KyosoConfig,
} from "../config/schema.js";
import type { AgentRunInput, AgentRunResult } from "../core/types.js";
import { isUnexpandedEnvPlaceholder } from "../utils/env.js";

export const OPENROUTER_ACP_SMOKE_OPT_IN_ENV = "KYOSO_OPENROUTER_ACP_SMOKE";
export const OPENROUTER_ACP_SMOKE_OPT_IN_VALUE = "release";
export const OPENROUTER_ACP_SMOKE_MODEL_ENV = "KYOSO_OPENROUTER_MODEL";
export const OPENROUTER_ACP_SMOKE_SUCCESS_MARKER =
  "KYOSO_OPENROUTER_ACP_SMOKE_OK";

const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const PATH_ENV = "PATH";
const OPENROUTER_ACP_SMOKE_TRACE_ID = "tr_openrouter_codex_acp_smoke";

export class OpenRouterCodexAcpSmokePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterCodexAcpSmokePreflightError";
  }
}

export class OpenRouterCodexAcpSmokeRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterCodexAcpSmokeRuntimeError";
  }
}

export type OpenRouterCodexAcpSmokeOptions = {
  env?: NodeJS.ProcessEnv;
  runAgent?: (
    input: AgentRunInput,
    config: KyosoConfig,
    childEnv: NodeJS.ProcessEnv,
  ) => Promise<AgentRunResult>;
};

export function assertOpenRouterCodexAcpSmokeArguments(input: {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}): void {
  if (input.positionals.length === 0 && Object.keys(input.flags).length === 0) {
    return;
  }
  throw new OpenRouterCodexAcpSmokePreflightError(
    "OpenRouter Codex ACP smoke accepts no arguments. Supply the opt-in, model, and credentials through environment variables only.",
  );
}

export function validateOpenRouterCodexAcpSmoke(env: NodeJS.ProcessEnv): {
  model: string;
} {
  if (
    env[OPENROUTER_ACP_SMOKE_OPT_IN_ENV] !== OPENROUTER_ACP_SMOKE_OPT_IN_VALUE
  ) {
    throw new OpenRouterCodexAcpSmokePreflightError(
      `OpenRouter Codex ACP smoke is disabled. Set ${OPENROUTER_ACP_SMOKE_OPT_IN_ENV}=${OPENROUTER_ACP_SMOKE_OPT_IN_VALUE} only for an approved release smoke run.`,
    );
  }

  assertUsableEnvironmentValue(env, PATH_ENV);
  assertUsableEnvironmentValue(env, OPENROUTER_API_KEY_ENV);
  const model = assertUsableEnvironmentValue(
    env,
    OPENROUTER_ACP_SMOKE_MODEL_ENV,
  );
  return { model };
}

export function createOpenRouterCodexAcpSmokeConfig(
  model: string,
): KyosoConfig {
  const baseConfig = kyosoConfigSchema.parse(defaultConfig);
  return {
    ...baseConfig,
    agents: {
      ...baseConfig.agents,
      codex: {
        ...baseConfig.agents.codex,
        provider: CODEX_OPENROUTER_PROVIDER,
        model,
      },
    },
  };
}

export async function runOpenRouterCodexAcpSmoke(
  options: OpenRouterCodexAcpSmokeOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const { model } = validateOpenRouterCodexAcpSmoke(env);
  const config = createOpenRouterCodexAcpSmokeConfig(model);
  const smokeRoot = await mkdtemp(
    join(tmpdir(), "kyoso-openrouter-acp-smoke-"),
  );
  const workspaceDir = join(smokeRoot, "workspace");
  const homeDir = join(smokeRoot, "home");
  const codexHomeDir = join(smokeRoot, "codex-home");
  try {
    await Promise.all([
      mkdir(workspaceDir),
      mkdir(homeDir),
      mkdir(codexHomeDir),
    ]);
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      HOME: homeDir,
      CODEX_HOME: codexHomeDir,
    };
    const input: AgentRunInput = {
      traceId: OPENROUTER_ACP_SMOKE_TRACE_ID,
      agent: "codex",
      role: config.agents.codex.role,
      tool: "plan_review",
      prompt: [
        "This is an authorized release smoke test.",
        `Reply with exactly ${OPENROUTER_ACP_SMOKE_SUCCESS_MARKER}.`,
        "Do not read files, call tools, or make changes.",
      ].join(" "),
      workspaceDir,
      timeoutMs: config.agents.codex.timeoutMs,
      networkMode: "model_only",
    };
    const runAgent =
      options.runAgent ??
      ((agentInput: AgentRunInput) =>
        new SubprocessAcpAgentManager(config, childEnv).runAgent(agentInput));

    let result: AgentRunResult;
    try {
      result = await runAgent(input, config, childEnv);
    } catch {
      throw new OpenRouterCodexAcpSmokeRuntimeError(
        "OpenRouter Codex ACP smoke did not complete successfully.",
      );
    }

    if (result.status !== "completed") {
      throw new OpenRouterCodexAcpSmokeRuntimeError(
        `OpenRouter Codex ACP smoke ended with status ${result.status}.`,
      );
    }
    if (result.rawText?.trim() !== OPENROUTER_ACP_SMOKE_SUCCESS_MARKER) {
      throw new OpenRouterCodexAcpSmokeRuntimeError(
        "OpenRouter Codex ACP smoke completed without the required success marker.",
      );
    }

    return "OpenRouter Codex ACP smoke passed.";
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

function assertUsableEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value || isUnexpandedEnvPlaceholder(value)) {
    throw new OpenRouterCodexAcpSmokePreflightError(
      `OpenRouter Codex ACP smoke requires a non-empty, expanded ${key} environment value.`,
    );
  }
  return value;
}
