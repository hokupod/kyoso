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
  AgentProgressEvent,
  AgentRunInput,
  AgentRunResult,
  ModelExecutionIdentity,
  ModelTokenUsage,
} from "../core/types.js";
import { KyosoCancellationError, throwIfAborted } from "../core/errors.js";
import { createModelExecutionIdentity } from "../core/modelExecutionIdentity.js";
import { normalizeModelTokenUsage } from "../core/tokenUsage.js";
import { sanitizeTextForDisplay } from "../security/sanitizeText.js";
import {
  ChildEnvPreflightError,
  buildChildLaunchContext,
} from "../utils/env.js";
import { BaseAcpAgentManager } from "./AcpAgentManager.js";
import {
  AcpNdJsonLineLimitError,
  limitAcpNdJsonLineBytes,
} from "./ndJsonLineLimit.js";
import {
  AgentOutputAccumulator,
  type AgentOutputMetrics,
  type MessagePhase,
} from "./AgentOutputAccumulator.js";
import { parseCodexRetryUpdate } from "./codexRetryUpdate.js";
import { normalizeAgentOutput, parseAgentOutputStrict } from "./normalize.js";

const DEFAULT_PROGRESS_HEARTBEAT_MS = 15_000;
const ACTIVITY_PROGRESS_THROTTLE_MS = 3_000;

export class SubprocessAcpAgentManager extends BaseAcpAgentManager {
  constructor(
    private readonly config: KyosoConfig,
    private readonly parentEnv: NodeJS.ProcessEnv = process.env,
  ) {
    super();
  }

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    const agentConfig = this.config.agents[input.agent];
    const startedAt = new Date().toISOString();
    if (!agentConfig.enabled) {
      return {
        agent: input.agent,
        role: input.role,
        status: "skipped",
        startedAt,
        completedAt: startedAt,
      };
    }

    const provider =
      input.agent === "codex" ? this.config.agents.codex.provider : undefined;
    let launchContext: ReturnType<typeof buildChildLaunchContext>;
    try {
      launchContext = buildChildLaunchContext(
        this.parentEnv,
        agentConfig.auth.envWhitelist,
        agentConfig.env,
        {
          agent: input.agent,
          model: agentConfig.model,
          provider,
          preferApiKey: agentConfig.auth.preferApiKey,
          openRouter:
            input.agent === "codex"
              ? this.config.agents.codex.openRouter
              : undefined,
        },
      );
    } catch (error) {
      return {
        agent: input.agent,
        role: input.role,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: buildPreflightFailure(error),
      };
    }

    try {
      return await runSubprocessAgent(
        input.agent,
        agentConfig,
        input,
        launchContext.env,
        launchContext.executionIdentity,
      );
    } catch (error) {
      if (error instanceof KyosoCancellationError) throw error;
      return {
        agent: input.agent,
        role: input.role,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        error: buildAgentFailure(
          formatAgentErrorDetail(error),
          "Agent process failed.",
        ),
      };
    }
  }
}

type AgentConfig = KyosoConfig["agents"][AgentName];

async function runSubprocessAgent(
  agent: AgentName,
  agentConfig: AgentConfig,
  input: AgentRunInput,
  env: NodeJS.ProcessEnv,
  launchExecutionIdentity: ModelExecutionIdentity,
): Promise<AgentRunResult> {
  throwIfAborted(input.signal);
  const startedAt = new Date().toISOString();
  const effectiveTimeoutMs = resolveEffectiveTimeoutMs(input);
  if (effectiveTimeoutMs <= 0) {
    return {
      agent,
      role: input.role,
      status: "timeout",
      startedAt,
      completedAt: startedAt,
      error: {
        code: "REVIEW_DEADLINE_EXCEEDED",
        message: "Review deadline was reached before the agent could start.",
      },
    };
  }

  return new Promise((resolveResult, rejectResult) => {
    const abortController = new AbortController();
    let cancelSession: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(agentConfig.command, agentConfig.args, {
      cwd: input.workspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      termination ??= terminateChild(child);
      return termination;
    };

    let stdout = "";
    let stderr = "";
    let settled = false;
    let spawned = false;
    let startedWrite: Promise<void> | undefined;
    child.once("spawn", () => {
      if (settled) return;
      spawned = true;
      startedWrite = Promise.resolve()
        .then(async () => {
          await input.onStarted?.(launchExecutionIdentity);
        })
        .catch(() => undefined);
    });

    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (result: AgentRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      const finalResult =
        spawned && result.executionIdentity === undefined
          ? { ...result, executionIdentity: launchExecutionIdentity }
          : result;
      void (startedWrite ?? Promise.resolve()).then(() =>
        resolveResult(finalResult),
      );
    };

    const rejectOnce = (error: KyosoCancellationError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error);
    };

    onAbort = () => {
      const cancellation = cancellationFromSignal(input.signal);
      if (timeout) clearTimeout(timeout);
      abortController.abort(cancellation);
      cancelSession?.();
      void terminate().then(() => rejectOnce(cancellation));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) {
      onAbort();
      return;
    }

    timeout = setTimeout(() => {
      abortController.abort(new Error("Kyoso agent timeout"));
      void terminate();
      const deadlineReached =
        input.deadlineAtEpochMs !== undefined &&
        Date.now() >= input.deadlineAtEpochMs;
      resolveOnce({
        agent,
        role: input.role,
        status: "timeout",
        startedAt,
        completedAt: new Date().toISOString(),
        error: {
          code: deadlineReached ? "REVIEW_DEADLINE_EXCEEDED" : "AGENT_TIMEOUT",
          message: deadlineReached
            ? "Review deadline reached before the agent completed."
            : `Agent timed out after ${effectiveTimeoutMs}ms`,
        },
      });
    }, effectiveTimeoutMs);

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
      abortController,
      resolveEffortConfigOption(agent, agentConfig.effort),
      launchExecutionIdentity,
      (cancel) => {
        cancelSession = cancel;
      },
    )
      .then(
        ({
          rawText,
          warnings,
          usage,
          messageBytes,
          thoughtBytes,
          outputBytes,
          outputWarningTriggered,
          observedStreamRetries,
          discardedRetryMessageBytes,
          firstOutputAt,
          lastAcpUpdateAt,
          stopReason,
          executionIdentity,
        }) => {
          stdout = rawText;
          const completed = stopReason === "end_turn";
          resolveOnce({
            agent,
            role: input.role,
            status: completed ? "completed" : "failed",
            rawText,
            normalized: normalizeAgentOutput(agent, input.role, rawText),
            startedAt,
            completedAt: new Date().toISOString(),
            messageBytes,
            thoughtBytes,
            outputBytes,
            outputWarningTriggered,
            observedStreamRetries,
            ...(discardedRetryMessageBytes === 0
              ? {}
              : { discardedRetryMessageBytes }),
            ...(firstOutputAt === undefined ? {} : { firstOutputAt }),
            ...(lastAcpUpdateAt === undefined ? {} : { lastAcpUpdateAt }),
            stopReason,
            executionIdentity,
            ...(usage ? { usage } : {}),
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(completed
              ? {}
              : {
                  error: {
                    code: "AGENT_STOPPED_EARLY",
                    message: `Agent stopped before completing the review: ${stopReason}.`,
                  },
                }),
          });
        },
      )
      .catch((error) => {
        if (error instanceof KyosoCancellationError) {
          void terminate().then(() => rejectOnce(error));
          return;
        }
        const outputLimitError = findOutputLimitError(error, abortController);
        if (outputLimitError) {
          stdout = outputLimitError.rawText;
          const normalized = parseAgentOutputStrict(agent, input.role, stdout);
          resolveOnce({
            agent,
            role: input.role,
            status: "failed",
            rawText: stdout,
            ...(normalized ? { normalized, salvaged: true } : {}),
            messageBytes: outputLimitError.messageBytes,
            thoughtBytes: outputLimitError.thoughtBytes,
            outputBytes: outputLimitError.outputBytes,
            outputWarningTriggered: outputLimitError.outputWarningTriggered,
            observedStreamRetries:
              outputLimitError.metrics.observedStreamRetries,
            ...(outputLimitError.metrics.discardedRetryMessageBytes === 0
              ? {}
              : {
                  discardedRetryMessageBytes:
                    outputLimitError.metrics.discardedRetryMessageBytes,
                }),
            ...(outputLimitError.metrics.firstOutputAt === undefined
              ? {}
              : { firstOutputAt: outputLimitError.metrics.firstOutputAt }),
            ...(outputLimitError.metrics.lastAcpUpdateAt === undefined
              ? {}
              : { lastAcpUpdateAt: outputLimitError.metrics.lastAcpUpdateAt }),
            stopReason: "cancelled",
            startedAt,
            completedAt: new Date().toISOString(),
            error: {
              code: "AGENT_OUTPUT_LIMIT",
              message: `Agent output exceeded the ${outputLimitError.maxOutputBytes}-byte hard limit (message: ${outputLimitError.messageBytes}, thought: ${outputLimitError.thoughtBytes}, total: ${outputLimitError.outputBytes}) and was cancelled. Adjust user-global reviewBudget.maxAgentOutputBytes to change this ceiling.`,
            },
          });
          return;
        }
        if (error instanceof AcpNdJsonLineLimitError) {
          abortController.abort(error);
          resolveOnce({
            agent,
            role: input.role,
            status: "failed",
            rawText: stdout,
            stopReason: "cancelled",
            startedAt,
            completedAt: new Date().toISOString(),
            error: {
              code: "AGENT_PROTOCOL_LIMIT",
              message: `Agent emitted an ACP NDJSON line above the ${error.maxLineBytes}-byte transport limit and was cancelled.`,
            },
          });
          return;
        }
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
        void terminate();
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
  abortController: AbortController,
  configOption: { configId: string; value: string } | undefined,
  launchExecutionIdentity: ModelExecutionIdentity,
  onSessionReady: (cancel: () => void) => void,
): Promise<{
  rawText: string;
  warnings: string[];
  usage?: ModelTokenUsage;
  messageBytes: number;
  thoughtBytes: number;
  outputBytes: number;
  outputWarningTriggered: boolean;
  observedStreamRetries: number;
  discardedRetryMessageBytes: number;
  firstOutputAt?: string;
  lastAcpUpdateAt?: string;
  stopReason: string;
  executionIdentity: ModelExecutionIdentity;
}> {
  if (!child.stdin || !child.stdout) {
    throw new Error("Agent process did not expose stdio streams.");
  }

  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const inputStream = Readable.toWeb(
    child.stdout,
  ) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(output, limitAcpNdJsonLineBytes(inputStream));
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
        const cancelSession = (): void => {
          void ctx
            .notify(methods.agent.session.cancel, {
              sessionId: session.sessionId,
            })
            .catch(() => undefined);
        };
        onSessionReady(cancelSession);
        throwIfAborted(input.signal);
        const warnings: string[] = [];
        if (configOption) {
          // Backend agents throw the same error both when a model doesn't
          // support effort levels (a normal, expected case) and when the
          // value is invalid (a misconfiguration). ACP gives no way to tell
          // these apart, so failing loud here would break reviews for models
          // that simply don't support effort. Record a warning (and log to
          // stderr) so a rejected effort isn't silently indistinguishable
          // from an applied one, for CLI and MCP/JSON callers alike.
          await ctx
            .request(
              methods.agent.session.setConfigOption,
              { sessionId: session.sessionId, ...configOption },
              { cancellationSignal: abortController.signal },
            )
            .catch((error) => {
              if (abortController.signal.aborted) return;
              const sanitizedValue = sanitizeTextForDisplay(configOption.value);
              const detail = sanitizeTextForDisplay(
                formatAgentErrorDetail(error),
              );
              const warning = `rejected effort config option (configId=${configOption.configId}, value=${sanitizedValue}); continuing without it: ${detail}`;
              warnings.push(warning);
              console.error(`kyoso: ${warning}`);
            });
        }
        const accumulator = new AgentOutputAccumulator();
        let messageBytes = 0;
        let thoughtBytes = 0;
        let outputBytes = 0;
        let outputWarningTriggered = false;
        const sessionStartedAtEpochMs = Date.now();
        let lastActivityAtEpochMs = 0;
        const emitProgress = (event: AgentProgressEvent): void => {
          try {
            const progress = input.onProgress?.(event);
            void Promise.resolve(progress).catch(() => undefined);
          } catch {
            // Progress notification failures must not stop the review.
          }
        };
        const heartbeatMs = input.heartbeatMs ?? DEFAULT_PROGRESS_HEARTBEAT_MS;
        const heartbeat =
          input.onProgress && heartbeatMs > 0
            ? setInterval(() => {
                const now = Date.now();
                const lastAcpUpdateAt = accumulator.metrics().lastAcpUpdateAt;
                const lastUpdateEpochMs = lastAcpUpdateAt
                  ? Date.parse(lastAcpUpdateAt)
                  : sessionStartedAtEpochMs;
                emitProgress({
                  type: "agent_waiting",
                  agent: input.agent,
                  elapsedMs: Math.max(0, now - sessionStartedAtEpochMs),
                  sinceLastAcpUpdateMs: Math.max(
                    0,
                    now -
                      (Number.isFinite(lastUpdateEpochMs)
                        ? lastUpdateEpochMs
                        : sessionStartedAtEpochMs),
                  ),
                  ...(input.streamIdleTimeoutMs === undefined
                    ? {}
                    : { streamIdleTimeoutMs: input.streamIdleTimeoutMs }),
                  timestamp: new Date(now).toISOString(),
                });
              }, heartbeatMs)
            : undefined;
        heartbeat?.unref?.();
        const stopHeartbeat = (): void => {
          if (heartbeat) clearInterval(heartbeat);
        };
        input.signal?.addEventListener("abort", stopHeartbeat, { once: true });

        try {
          const promptResponse = session.prompt(input.prompt, {
            cancellationSignal: abortController.signal,
          });
          void promptResponse.catch(() => undefined);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === "stop") {
              const usage = normalizeUsage(message.response.usage);
              return {
                rawText: accumulator.finalRawText(),
                warnings,
                ...(usage ? { usage } : {}),
                messageBytes,
                thoughtBytes,
                outputBytes,
                outputWarningTriggered,
                ...accumulator.metrics(),
                stopReason: message.stopReason,
                executionIdentity: withReportedExecutionIdentity(
                  launchExecutionIdentity,
                  message.response._meta,
                ),
              };
            }

            const update = message.update;
            accumulator.noteUpdate();
            const retry = parseCodexRetryUpdate(update);
            if (retry) {
              const boundary = accumulator.markRetryBoundary();
              emitProgress({
                type: "agent_retrying",
                agent: input.agent,
                observedRetry: accumulator.metrics().observedStreamRetries,
                ...(retry.attempt === undefined
                  ? {}
                  : { attempt: retry.attempt }),
                ...(retry.maxRetries === undefined
                  ? {}
                  : { maxRetries: retry.maxRetries }),
                reason: retry.message,
                discardedMessageBytes: boundary.discardedMessageBytes,
                timestamp: new Date().toISOString(),
              });
              continue;
            }
            if (
              (update.sessionUpdate !== "agent_message_chunk" &&
                update.sessionUpdate !== "agent_thought_chunk") ||
              update.content.type !== "text"
            ) {
              continue;
            }
            const chunkBytes = Buffer.byteLength(update.content.text, "utf8");
            const isMessage = update.sessionUpdate === "agent_message_chunk";
            const nextMessageBytes =
              messageBytes + (isMessage ? chunkBytes : 0);
            const nextThoughtBytes =
              thoughtBytes + (isMessage ? 0 : chunkBytes);
            const nextOutputBytes = nextMessageBytes + nextThoughtBytes;
            const nextOutputWarningTriggered: boolean =
              outputWarningTriggered ||
              (input.warnOutputBytes !== undefined &&
                nextOutputBytes >= input.warnOutputBytes);
            if (
              input.maxOutputBytes !== undefined &&
              nextOutputBytes > input.maxOutputBytes
            ) {
              if (isMessage) {
                accumulator.addMessageChunk(
                  utf8Prefix(
                    update.content.text,
                    input.maxOutputBytes - outputBytes,
                  ),
                  readChunkMeta(update),
                );
              }
              const retainedRawText = accumulator.finalRawText();
              await ctx
                .notify(methods.agent.session.cancel, {
                  sessionId: session.sessionId,
                })
                .catch(() => undefined);
              const error = new AgentOutputLimitError(
                retainedRawText,
                nextMessageBytes,
                nextThoughtBytes,
                nextOutputBytes,
                input.maxOutputBytes,
                nextOutputWarningTriggered,
                accumulator.metrics(),
              );
              abortController.abort(error);
              throw error;
            }
            if (isMessage) {
              accumulator.addMessageChunk(
                update.content.text,
                readChunkMeta(update),
              );
            } else {
              accumulator.addThoughtChunk(update.content.text);
            }
            messageBytes = nextMessageBytes;
            thoughtBytes = nextThoughtBytes;
            outputBytes = nextOutputBytes;
            outputWarningTriggered = nextOutputWarningTriggered;
            const now = Date.now();
            if (now - lastActivityAtEpochMs >= ACTIVITY_PROGRESS_THROTTLE_MS) {
              lastActivityAtEpochMs = now;
              emitProgress({
                type: "agent_activity",
                agent: input.agent,
                activity: isMessage ? "message" : "thought",
                totalOutputBytes: outputBytes,
                timestamp: new Date(now).toISOString(),
              });
            }
          }
        } finally {
          stopHeartbeat();
          input.signal?.removeEventListener("abort", stopHeartbeat);
        }
      });
  });
}

function utf8Prefix(input: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(input);
  const budget = Math.max(0, Math.min(maxBytes, encoded.byteLength));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = budget; end > 0; end -= 1) {
    try {
      return decoder.decode(encoded.subarray(0, end));
    } catch {
      // Retry after backing off to a UTF-8 character boundary.
    }
  }
  return "";
}

class AgentOutputLimitError extends Error {
  constructor(
    readonly rawText: string,
    readonly messageBytes: number,
    readonly thoughtBytes: number,
    readonly outputBytes: number,
    readonly maxOutputBytes: number,
    readonly outputWarningTriggered: boolean,
    readonly metrics: AgentOutputMetrics,
  ) {
    super(`Agent output exceeded ${maxOutputBytes} bytes.`);
    this.name = "AgentOutputLimitError";
  }
}

function findOutputLimitError(
  error: unknown,
  abortController: AbortController,
): AgentOutputLimitError | undefined {
  if (error instanceof AgentOutputLimitError) return error;
  const reason = abortController.signal.reason;
  return reason instanceof AgentOutputLimitError ? reason : undefined;
}

function cancellationFromSignal(
  signal: AbortSignal | undefined,
): KyosoCancellationError {
  if (signal?.reason instanceof KyosoCancellationError) return signal.reason;
  return new KyosoCancellationError(
    typeof signal?.reason === "string" ? signal.reason : undefined,
  );
}

function resolveEffectiveTimeoutMs(input: AgentRunInput): number {
  const deadlineRemaining =
    input.deadlineAtEpochMs === undefined
      ? Number.POSITIVE_INFINITY
      : input.deadlineAtEpochMs - Date.now();
  return Math.max(0, Math.min(input.timeoutMs, deadlineRemaining));
}

function normalizeUsage(usage: unknown): ModelTokenUsage | undefined {
  return normalizeModelTokenUsage(usage);
}

function withReportedExecutionIdentity(
  identity: ModelExecutionIdentity,
  metadata: unknown,
): ModelExecutionIdentity {
  const record = isRecord(metadata) ? metadata : {};
  return createModelExecutionIdentity({
    providerRoute: identity.providerRoute,
    requestedModel: identity.requestedModel,
    reportedProvider: record.provider,
    reportedModel: record.model,
  });
}

function readChunkMeta(update: unknown): {
  messageId?: string;
  phase: MessagePhase;
} {
  const record = isRecord(update) ? update : {};
  const metadata = isRecord(record._meta) ? record._meta : {};
  const codex = isRecord(metadata.codex) ? metadata.codex : {};
  const phase =
    codex.phase === "commentary" || codex.phase === "final_answer"
      ? codex.phase
      : "unknown";
  return {
    ...(typeof record.messageId === "string"
      ? { messageId: record.messageId }
      : {}),
    phase,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function terminateChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;
    let onClose: (() => void) | undefined;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (onClose) child.off("close", onClose);
      resolve();
    };

    onClose = () => settle();
    child.once("close", onClose);
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        settle();
        return;
      }
      child.kill("SIGKILL");
      escalationTimer = setTimeout(settle, 500);
      escalationTimer.unref();
    }, 2_000);
    killTimer.unref();
  });
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

function buildPreflightFailure(error: unknown): {
  code: string;
  message: string;
  detail?: string;
} {
  if (error instanceof ChildEnvPreflightError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  const detail = sanitizeTextForDisplay(formatAgentErrorDetail(error));
  return {
    code: "AGENT_CONFIG_INVALID",
    message:
      "Agent configuration is invalid. Run kyoso doctor and check agent configuration.",
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
