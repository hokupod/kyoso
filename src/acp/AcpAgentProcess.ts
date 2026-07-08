import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { KyosoConfig } from "../config/schema.js";
import type {
  AgentName,
  AgentRunInput,
  AgentRunResult,
} from "../core/types.js";
import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import { buildChildEnv } from "../utils/env.js";
import { BaseAcpAgentManager } from "./AcpAgentManager.js";
import { normalizeAgentOutput } from "./normalize.js";

export class SubprocessAcpAgentManager extends BaseAcpAgentManager {
  constructor(private readonly config: KyosoConfig) {
    super();
  }

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    const agentConfig = this.config.agents[input.agent];
    if (!agentConfig.enabled) {
      return {
        agent: input.agent,
        role: input.role,
        status: "skipped",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    return runSubprocessAgent(input.agent, agentConfig, input);
  }
}

type AgentConfig = KyosoConfig["agents"][AgentName];

async function runSubprocessAgent(
  agent: AgentName,
  agentConfig: AgentConfig,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const startedAt = new Date().toISOString();
  const env = buildChildEnv(
    process.env,
    agentConfig.auth.envWhitelist,
    agentConfig.env,
    {
      agent,
      model: agentConfig.model,
      preferApiKey: agentConfig.auth.preferApiKey,
    },
  );

  return new Promise((resolveResult) => {
    const child = spawn(agentConfig.command, agentConfig.args, {
      cwd: input.workspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const abortController = new AbortController();

    const resolveOnce = (result: AgentRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(result);
    };

    const timeout = setTimeout(() => {
      abortController.abort(new Error("Kyoso agent timeout"));
      terminateChild(child);
      resolveOnce({
        agent,
        role: input.role,
        status: "timeout",
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: "AGENT_TIMEOUT",
          message: `Agent timed out after ${input.timeoutMs}ms`,
        },
      });
    }, input.timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      const failure = buildAgentFailure(
        error.message,
        "Agent process could not be started.",
      );
      resolveOnce({
        agent,
        role: input.role,
        status: "failed",
        rawText: stdout,
        startedAt,
        completedAt: new Date().toISOString(),
        error: failure,
      });
    });

    runAcpClientWorkflow(
      child,
      input,
      abortController.signal,
      resolveEffortConfigOption(agent, agentConfig.effort),
    )
      .then((rawText) => {
        stdout = rawText;
        resolveOnce({
          agent,
          role: input.role,
          status: "completed",
          rawText,
          normalized: normalizeAgentOutput(agent, input.role, rawText),
          startedAt,
          completedAt: new Date().toISOString(),
        });
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        const failureText = [stderr, formatAgentErrorDetail(error)]
          .filter((part) => part.trim().length > 0)
          .join("\n");
        resolveOnce({
          agent,
          role: input.role,
          status: "failed",
          rawText: stdout,
          startedAt,
          completedAt: new Date().toISOString(),
          error: buildAgentFailure(failureText, "Agent process failed."),
        });
      })
      .finally(() => {
        terminateChild(child);
      });

    child.on("close", (code) => {
      if (settled || code === 0 || abortController.signal.aborted) return;
      const fallback = `Agent exited with code ${code ?? "unknown"}`;
      resolveOnce({
        agent,
        role: input.role,
        status: "failed",
        rawText: stdout,
        startedAt,
        completedAt: new Date().toISOString(),
        error: buildAgentFailure(stderr, fallback),
      });
    });
  });
}

async function runAcpClientWorkflow(
  child: ReturnType<typeof spawn>,
  input: AgentRunInput,
  signal: AbortSignal,
  configOption: { configId: string; value: string } | undefined,
): Promise<string> {
  if (!child.stdin || !child.stdout) {
    throw new Error("Agent process did not expose stdio streams.");
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(
    child.stdout,
  ) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, inputStream);
  const app = client({ name: "kyoso" })
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" },
    }))
    .onRequest(methods.client.fs.readTextFile, async (ctx) => ({
      content: await readWorkspaceFile(
        input.workspaceDir,
        ctx.params.path,
        ctx.params.line,
        ctx.params.limit,
      ),
    }))
    .onRequest(methods.client.fs.writeTextFile, () => {
      throw RequestError.invalidRequest({
        policy: "Kyoso denies ACP file writes.",
      });
    })
    .onRequest(methods.client.terminal.create, () => {
      throw RequestError.invalidRequest({
        policy: "Kyoso denies ACP terminal execution.",
      });
    })
    .onRequest(methods.client.terminal.output, () => {
      throw RequestError.invalidRequest({
        policy: "Kyoso does not create terminals.",
      });
    })
    .onRequest(methods.client.terminal.release, () => ({}))
    .onRequest(methods.client.terminal.waitForExit, () => {
      throw RequestError.invalidRequest({
        policy: "Kyoso does not create terminals.",
      });
    })
    .onRequest(methods.client.terminal.kill, () => ({}));

  return app.connectWith(stream, async (ctx) => {
    await ctx.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: false,
        },
      },
    });

    return ctx
      .buildSession({
        cwd: input.workspaceDir,
        mcpServers: [],
        _meta: {
          kyosoTraceId: input.traceId,
          kyosoTool: input.tool,
          kyosoNetworkMode: input.networkMode,
          kyosoReadOnly: true,
        },
      })
      .withSession(async (session) => {
        if (configOption) {
          // Backend agents throw the same error both when a model doesn't
          // support effort levels (a normal, expected case) and when the
          // value is invalid (a misconfiguration). ACP gives no way to tell
          // these apart, so failing loud here would break reviews for models
          // that simply don't support effort. Log to stderr so a rejected
          // effort isn't silently indistinguishable from an applied one.
          await ctx
            .request(
              methods.agent.session.setConfigOption,
              { sessionId: session.sessionId, ...configOption },
              { cancellationSignal: signal },
            )
            .catch((error) => {
              if (signal.aborted) return;
              const detail = sanitizeTextForDisplay(
                error instanceof Error ? error.message : String(error),
              );
              console.error(
                `kyoso: rejected effort config option (configId=${configOption.configId}, value=${configOption.value}); continuing without it: ${detail}`,
              );
            });
        }
        const promptResponse = session.prompt(input.prompt, {
          cancellationSignal: signal,
        });
        const text = await session.readText();
        await promptResponse;
        return text;
      });
  });
}

function resolveEffortConfigOption(
  agent: AgentName,
  effort: string | undefined,
): { configId: string; value: string } | undefined {
  if (!effort) return undefined;
  if (agent === "codex") return { configId: "reasoning_effort", value: effort };
  if (agent === "claude") return { configId: "effort", value: effort };
  return undefined;
}

export async function readWorkspaceFile(
  workspaceDir: string,
  requestedPath: string,
  line?: number | null,
  limit?: number | null,
): Promise<string> {
  const workspaceRoot = await realpath(workspaceDir);
  const candidates = resolveReadablePaths(workspaceRoot, requestedPath);

  let content: string | undefined;
  for (const absolute of candidates) {
    const readablePath = await resolveReadableFile(workspaceRoot, absolute);
    if (!readablePath) continue;
    content = await readFile(readablePath, "utf8").catch(() => undefined);
    if (content !== undefined) break;
  }
  if (content === undefined) throw RequestError.resourceNotFound(requestedPath);
  const lines = content.split("\n");
  const start = Math.max((line ?? 1) - 1, 0);
  const end = limit && limit > 0 ? start + limit : undefined;
  return lines.slice(start, end).join("\n");
}

async function resolveReadableFile(
  workspaceRoot: string,
  absolute: string,
): Promise<string | undefined> {
  const realPath = await realpath(absolute).catch((error: unknown) => {
    if (isMissingPathError(error)) return undefined;
    throw error;
  });
  if (!realPath) return undefined;
  assertWithinWorkspace(workspaceRoot, realPath);
  return realPath;
}

function resolveReadablePaths(
  workspaceRoot: string,
  requestedPath: string,
): string[] {
  const primary = resolve(workspaceRoot, requestedPath);
  assertWithinWorkspace(workspaceRoot, primary);

  const relativePath = relative(workspaceRoot, primary).replaceAll("\\", "/");
  if (relativePath.startsWith("context/") || relativePath.startsWith("repo/")) {
    return [primary];
  }

  const repoPath = resolve(workspaceRoot, "repo", relativePath);
  assertWithinWorkspace(workspaceRoot, repoPath);
  return isAbsolute(requestedPath) ? [primary, repoPath] : [repoPath, primary];
}

function assertWithinWorkspace(workspaceRoot: string, absolute: string): void {
  const relativePath = relative(workspaceRoot, absolute);
  if (
    relativePath.startsWith("..") ||
    relativePath === "" ||
    relativePath.startsWith("/")
  ) {
    throw RequestError.invalidRequest({
      policy: "Kyoso only allows reads from the temporary snapshot.",
    });
  }
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 2_000);
  killTimer.unref();
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function buildAgentFailure(
  rawDetail: string,
  fallbackMessage: string,
): { code: string; message: string; detail?: string } {
  const code = classifyAgentFailure(rawDetail);
  const detail = sanitizeTextForDisplay(rawDetail.trim());
  return {
    code,
    message: safeAgentFailureMessage(code, fallbackMessage),
    ...(detail ? { detail } : {}),
  };
}

function safeAgentFailureMessage(
  code: string,
  fallbackMessage: string,
): string {
  if (code === "AUTH_FAILED") {
    return "Agent authentication failed. Run kyoso doctor and check configured credentials.";
  }
  if (code === "PERMISSION_DENIED") {
    return "Agent request was denied by Kyoso policy.";
  }
  if (code === "AGENT_NETWORK_FAILED") {
    return "Agent adapter package could not be resolved due to network or cache failure.";
  }
  if (code === "AGENT_SPAWN_FAILED") {
    return "Agent process could not be started.";
  }
  return sanitizeTextForDisplay(fallbackMessage);
}

function classifyAgentFailure(stderr: string): string {
  if (/spawn/i.test(stderr)) return "AGENT_SPAWN_FAILED";
  if (
    /ENOTFOUND|ENOTCACHED|ECONNREFUSED|ETIMEDOUT|registry\.npmjs\.org|network request|cache mode/i.test(
      stderr,
    )
  ) {
    return "AGENT_NETWORK_FAILED";
  }
  if (/auth|api key|login|credential/i.test(stderr)) return "AUTH_FAILED";
  if (/permission|policy|write|terminal/i.test(stderr))
    return "PERMISSION_DENIED";
  return "AGENT_FAILED";
}

function formatAgentErrorDetail(error: unknown): string {
  if (error instanceof RequestError) {
    const data = stringifyErrorData(error.data);
    return data ? `${error.message}; data: ${data}` : error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function stringifyErrorData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
