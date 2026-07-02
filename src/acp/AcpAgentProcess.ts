import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
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

    runAcpClientWorkflow(child, input, abortController.signal)
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
        const failureText = `${stderr}\n${error instanceof Error ? error.message : String(error)}`;
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

  return app.connectWith(stream, async (ctx) =>
    ctx
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
        const promptResponse = session.prompt(input.prompt, {
          cancellationSignal: signal,
        });
        const text = await session.readText();
        await promptResponse;
        return text;
      }),
  );
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
): { code: string; message: string } {
  const code = classifyAgentFailure(rawDetail);
  return { code, message: safeAgentFailureMessage(code, fallbackMessage) };
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
  if (code === "AGENT_SPAWN_FAILED") {
    return "Agent process could not be started.";
  }
  return sanitizeTextForDisplay(fallbackMessage);
}

function classifyAgentFailure(stderr: string): string {
  if (/spawn/i.test(stderr)) return "AGENT_SPAWN_FAILED";
  if (/auth|api key|login|credential/i.test(stderr)) return "AUTH_FAILED";
  if (/permission|policy|write|terminal/i.test(stderr))
    return "PERMISSION_DENIED";
  return "AGENT_FAILED";
}
