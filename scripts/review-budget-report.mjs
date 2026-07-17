#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_CALL_KINDS = new Set(["primary", "verifier", "judge"]);
const AGENT_STREAM_CALL_KINDS = new Set(["primary", "verifier"]);
const OPTIONAL_CALL_KINDS = new Set(["verifier", "judge"]);
const PROVIDER_ROUTES = new Set([
  "codex_default",
  "claude_default",
  "openrouter",
  "openai",
  "anthropic",
]);
const TOKEN_USAGE_KEYS = [
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "thoughtTokens",
  "cachedReadTokens",
  "cachedWriteTokens",
];
const CREDENTIAL_PATTERNS = [
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}\b/i,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{8,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/i,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
  /\bglpat-[A-Za-z0-9_-]{8,}\b/i,
  /\bnpm_[A-Za-z0-9]{16,}\b/i,
  /\bpypi-[A-Za-z0-9_-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]{8,}\b/i,
  new RegExp(
    ["-{5}BEGIN ", "(?:RSA |OPENSSH |DSA |EC |PGP )?", "PRIVATE KEY-{5}"].join(
      "",
    ),
    "i",
  ),
];
const UNSAFE_METADATA_PATTERN =
  /(?:https?|wss?):\/\/|\b(?:api[_-]?key|access[_-]?key|authorization|base[_-]?url|client[_-]?secret|credential|private[_ -]?key|secret|token|password)\b|[{}=]/i;
const MAX_METADATA_CHARS = 160;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INTERNAL_WORKER_FLAG = "--internal-anchored-worker";
const MAX_WORKER_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_WORKER_ERROR_BYTES = 64 * 1024;
const DEFAULT_TRACE_ROOT_FS = Object.freeze({
  lstat,
  open,
});
export const REPORT_LIMITS = Object.freeze({
  jsonlFiles: 10_000,
  directories: 10_000,
  directoryEntries: 100_000,
  traceFileBytes: 16 * 1024 * 1024,
  totalTraceBytes: 256 * 1024 * 1024,
  jsonlLines: 1_000_000,
  jsonlLineBytes: 1024 * 1024,
  parsedEvents: 250_000,
  completedCalls: 100_000,
  completedReviews: 100_000,
  outputWarningEvents: 100_000,
  correlationKeys: 100_000,
  executionGroups: 10_000,
  distinctReasons: 10_000,
});
const WORKER_FAILURE_MESSAGE = "Anchored trace worker rejected the input.";
const SAFE_WORKER_ERROR_MESSAGES = new Set([
  "The trace directory identity is invalid.",
  "Trace directory changed during traversal; report aborted.",
  "Trace directories exceed the report input limit.",
  "Trace directory entries exceed the report input limit.",
  "A trace directory entry name is invalid.",
  "A trace directory does not expose a stable file identity.",
  "A trace file exceeds the per-file byte limit.",
  "Trace files exceed the report input limit.",
  "Trace files exceed the total report byte limit.",
  "JSONL lines exceed the report input limit.",
  "A JSONL line exceeds the report input byte limit.",
  "Trace events exceed the report input limit.",
  "Secure trace-file open capability is unavailable.",
  "A trace file changed after discovery; report aborted.",
  "A trace file exceeds its discovered byte limit.",
  "A trace file changed while reading; report aborted.",
  "Output warning events exceed the report input limit.",
  "Completed reviews exceed the report input limit.",
  "Completed model calls exceed the report input limit.",
  "Execution groups exceed the report input limit.",
  "Distinct trace reasons exceed the report input limit.",
  "Trace correlation keys exceed the report input limit.",
]);

export async function buildReviewBudgetReport(traceDir) {
  const rootIdentity = await inspectTraceRoot(traceDir);
  return runAnchoredTraceWorker(traceDir, rootIdentity);
}

async function runAnchoredTraceWorker(traceDir, rootIdentity) {
  return new Promise((resolveReport, rejectReport) => {
    const child = spawn(
      process.execPath,
      [
        SCRIPT_PATH,
        INTERNAL_WORKER_FLAG,
        String(rootIdentity.device),
        String(rootIdentity.inode),
      ],
      {
        cwd: traceDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const outputChunks = [];
    const errorChunks = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let outputExceeded = false;
    let errorExceeded = false;
    let settled = false;

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_WORKER_REPORT_BYTES) {
        outputExceeded = true;
        child.kill();
        return;
      }
      outputChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes > MAX_WORKER_ERROR_BYTES) {
        errorExceeded = true;
        child.kill();
        return;
      }
      errorChunks.push(chunk);
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      rejectReport(new Error(WORKER_FAILURE_MESSAGE));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (outputExceeded || errorExceeded) {
        rejectReport(new Error(WORKER_FAILURE_MESSAGE));
        return;
      }
      if (code !== 0) {
        const workerMessage = Buffer.concat(errorChunks, errorBytes)
          .toString("utf8")
          .trim();
        rejectReport(
          new Error(
            SAFE_WORKER_ERROR_MESSAGES.has(workerMessage)
              ? workerMessage
              : WORKER_FAILURE_MESSAGE,
          ),
        );
        return;
      }
      try {
        const report = JSON.parse(
          Buffer.concat(outputChunks, outputBytes).toString("utf8"),
        );
        if (!isRecord(report) || !isRecord(report.source)) {
          throw new Error(WORKER_FAILURE_MESSAGE);
        }
        resolveReport(report);
      } catch {
        rejectReport(new Error(WORKER_FAILURE_MESSAGE));
      }
    });
  });
}

export function parseReportArgs(argv) {
  let traceDir;
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--trace-dir") {
      if (traceDir !== undefined) {
        throw new Error("--trace-dir may be specified only once.");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --trace-dir.");
      }
      traceDir = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (help) return { help: true, json, traceDir };
  if (!traceDir) throw new Error("--trace-dir is required.");
  if (!isAbsolute(traceDir)) {
    throw new Error("--trace-dir must be an absolute path.");
  }
  return { help: false, json, traceDir };
}

export function renderHumanReport(report) {
  return [
    "Kyoso review budget report",
    `Trace files: ${report.source.jsonlFiles}`,
    `Completed reviews: ${report.reviews.completed}`,
    `Completed model-call events: ${report.calls.completed}`,
    `Output-signal-eligible calls: ${report.calls.outputSignalEligible}`,
    `Normal-path model calls: ${report.calls.normalPath}`,
    `Output warning events: ${report.outputSignals.agentOutputWarning.events}`,
    `Correlated output-warning calls: ${report.outputSignals.agentOutputWarning.calls}`,
    `Uncorrelated output-warning events: ${report.outputSignals.agentOutputWarning.uncorrelatedEvents}`,
    `Output-limit calls: ${report.outputSignals.agentOutputLimit.calls}`,
    "Token and cost values are not estimated from bytes.",
  ].join("\n");
}

export async function inspectTraceRoot(
  traceDir,
  fileSystem = DEFAULT_TRACE_ROOT_FS,
) {
  if (typeof traceDir !== "string" || !isAbsolute(traceDir)) {
    throw new Error("--trace-dir must be an absolute path.");
  }
  const rootInfo = await fileSystem.lstat(traceDir, { bigint: true });
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("--trace-dir must name a real directory, not a symlink.");
  }
  if (!hasStableDirectoryIdentity(rootInfo)) {
    throw new Error(
      "The trace directory does not expose a stable file identity.",
    );
  }

  const rootFlags =
    fsConstants.O_RDONLY |
    (fsConstants.O_DIRECTORY ?? 0) |
    (fsConstants.O_NOFOLLOW ?? 0);
  let rootHandle;
  try {
    rootHandle = await fileSystem.open(traceDir, rootFlags);
  } catch {
    throw new Error("The trace directory could not be opened securely.");
  }
  try {
    const openedRootInfo = await rootHandle.stat({ bigint: true });
    assertTraceRootIdentity(rootInfo, openedRootInfo);
    const currentRootInfo = await fileSystem.lstat(traceDir, { bigint: true });
    assertTraceRootIdentity(openedRootInfo, currentRootInfo);
    return {
      device: openedRootInfo.dev,
      inode: openedRootInfo.ino,
    };
  } finally {
    await rootHandle.close();
  }
}

export async function buildAnchoredReviewBudgetReport(rootIdentity) {
  if (!hasStableIdentity(rootIdentity)) {
    throw new Error("The trace directory identity is invalid.");
  }
  await assertCurrentDirectoryIdentity(rootIdentity);
  const state = createAggregationState();
  await walkAnchoredTraceDirectory(state, [], rootIdentity);
  await assertCurrentDirectoryIdentity(rootIdentity);
  return finalizeReport(state);
}

async function walkAnchoredTraceDirectory(state, pathSegments, identity) {
  await assertCurrentDirectoryIdentity(identity);
  state.source.directories += 1;
  if (state.source.directories > REPORT_LIMITS.directories) {
    throw new Error("Trace directories exceed the report input limit.");
  }

  const entries = [];
  const directoryHandle = await opendir(".");
  for await (const entry of directoryHandle) {
    state.source.directoryEntries += 1;
    if (state.source.directoryEntries > REPORT_LIMITS.directoryEntries) {
      throw new Error("Trace directory entries exceed the report input limit.");
    }
    entries.push(entry);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of entries) {
    await assertCurrentDirectoryIdentity(identity);
    if (!isSafeDirectoryEntryName(entry.name)) {
      throw new Error("A trace directory entry name is invalid.");
    }
    const info = await lstat(entry.name, { bigint: true });
    if (info.isSymbolicLink()) {
      state.source.skippedSymlinks += 1;
      continue;
    }
    if (info.isDirectory()) {
      if (!hasStableDirectoryIdentity(info)) {
        throw new Error(
          "A trace directory does not expose a stable file identity.",
        );
      }
      const childIdentity = { device: info.dev, inode: info.ino };
      process.chdir(entry.name);
      try {
        await assertCurrentDirectoryIdentity(childIdentity);
        await walkAnchoredTraceDirectory(
          state,
          [...pathSegments, entry.name],
          childIdentity,
        );
      } finally {
        process.chdir("..");
        await assertCurrentDirectoryIdentity(identity);
      }
      continue;
    }
    if (!info.isFile() || !entry.name.endsWith(".jsonl")) continue;

    if (info.size > BigInt(REPORT_LIMITS.traceFileBytes)) {
      throw new Error("A trace file exceeds the per-file byte limit.");
    }
    if (state.source.jsonlFiles >= REPORT_LIMITS.jsonlFiles) {
      throw new Error("Trace files exceed the report input limit.");
    }
    const size = Number(info.size);
    if (state.source.jsonlBytes + size > REPORT_LIMITS.totalTraceBytes) {
      throw new Error("Trace files exceed the total report byte limit.");
    }
    const file = {
      name: entry.name,
      key: [...pathSegments, entry.name].join("/"),
      size,
      device: info.dev,
      inode: info.ino,
      modifiedAtNs: info.mtimeNs,
      changedAtNs: info.ctimeNs,
    };
    state.source.jsonlFiles += 1;
    state.source.jsonlBytes += size;
    const contents = await readBoundedTraceFile(file);
    aggregateTraceContents(state, contents, file.key);
  }

  await assertCurrentDirectoryIdentity(identity);
}

function aggregateTraceContents(state, contents, fileKey) {
  for (const line of jsonlLines(contents)) {
    if (state.source.jsonlLines >= REPORT_LIMITS.jsonlLines) {
      throw new Error("JSONL lines exceed the report input limit.");
    }
    state.source.jsonlLines += 1;
    if (Buffer.byteLength(line, "utf8") > REPORT_LIMITS.jsonlLineBytes) {
      throw new Error("A JSONL line exceeds the report input byte limit.");
    }
    if (!line || line.trim().length === 0) {
      state.source.emptyLines += 1;
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      state.source.malformedLines += 1;
      continue;
    }
    if (!isRecord(event)) {
      state.source.malformedLines += 1;
      continue;
    }
    if (state.source.parsedEvents >= REPORT_LIMITS.parsedEvents) {
      throw new Error("Trace events exceed the report input limit.");
    }
    state.source.parsedEvents += 1;
    aggregateEvent(state, event, fileKey);
  }
}

export async function readBoundedTraceFile(file) {
  const noFollow = fsConstants.O_NOFOLLOW;
  const nonBlock = fsConstants.O_NONBLOCK;
  if (
    !isSafeDirectoryEntryName(file.name) ||
    typeof noFollow !== "number" ||
    noFollow <= 0 ||
    typeof nonBlock !== "number" ||
    nonBlock <= 0
  ) {
    throw new Error("Secure trace-file open capability is unavailable.");
  }
  const handle = await open(
    file.name,
    fsConstants.O_RDONLY | noFollow | nonBlock,
  );
  try {
    const info = await handle.stat({ bigint: true });
    if (!matchesDiscoveredTraceFile(info, file)) {
      throw new Error("A trace file changed after discovery; report aborted.");
    }

    const chunks = [];
    let bytes = 0;
    if (file.size > 0) {
      const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: file.size - 1,
      });
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > file.size || bytes > REPORT_LIMITS.traceFileBytes) {
          throw new Error("A trace file exceeds its discovered byte limit.");
        }
        chunks.push(chunk);
      }
    }
    const finalInfo = await handle.stat({ bigint: true });
    if (bytes !== file.size || !matchesDiscoveredTraceFile(finalInfo, file)) {
      throw new Error("A trace file changed while reading; report aborted.");
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function assertCurrentDirectoryIdentity(expected) {
  const current = await lstat(".", { bigint: true });
  if (
    current.isSymbolicLink() ||
    !hasStableDirectoryIdentity(current) ||
    current.dev !== expected.device ||
    current.ino !== expected.inode
  ) {
    throw new Error(
      "Trace directory changed during traversal; report aborted.",
    );
  }
}

function assertTraceRootIdentity(expected, actual) {
  if (
    actual.isSymbolicLink() ||
    !hasStableDirectoryIdentity(actual) ||
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino
  ) {
    throw new Error(
      "Trace directory changed during validation; report aborted.",
    );
  }
}

function hasStableDirectoryIdentity(info) {
  return info.isDirectory() && info.dev !== 0n && info.ino !== 0n;
}

function hasStableIdentity(identity) {
  return (
    isRecord(identity) &&
    typeof identity.device === "bigint" &&
    identity.device !== 0n &&
    typeof identity.inode === "bigint" &&
    identity.inode !== 0n
  );
}

function isSafeDirectoryEntryName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function matchesDiscoveredTraceFile(info, file) {
  return (
    info.isFile() &&
    info.size === BigInt(file.size) &&
    info.size <= BigInt(REPORT_LIMITS.traceFileBytes) &&
    (file.device === 0n || info.dev === file.device) &&
    (file.inode === 0n || info.ino === file.inode) &&
    info.mtimeNs === file.modifiedAtNs &&
    info.ctimeNs === file.changedAtNs
  );
}

function createAggregationState() {
  return {
    source: {
      jsonlFiles: 0,
      jsonlBytes: 0,
      jsonlLines: 0,
      parsedEvents: 0,
      malformedLines: 0,
      emptyLines: 0,
      ignoredEvents: 0,
      invalidEvents: 0,
      skippedSymlinks: 0,
      directories: 0,
      directoryEntries: 0,
    },
    completedReviews: new Set(),
    completionReasons: new Map(),
    reviewTokenStatuses: new Map([
      ["reported", 0],
      ["partial", 0],
      ["unknown", 0],
    ]),
    completedCalls: 0,
    outputSignalEligibleCalls: 0,
    identityStatuses: new Map([
      ["reported", 0],
      ["requested_only", 0],
      ["unknown", 0],
      ["missing", 0],
    ]),
    callGroups: new Map(),
    agentStreamByteValues: createByteValues(),
    normalPathAgentStreamByteValues: createByteValues(),
    outputWarningEvents: 0,
    completedCallEvents: new Map(),
    outputWarningCallEvents: new Map(),
    outputLimitCalls: 0,
    outputLimitReviews: new Set(),
    optionalSkipTotal: 0,
    optionalSkipReasons: new Map(),
    optionalSkipKindReasons: new Map(),
  };
}

function aggregateEvent(state, event, fileKey) {
  const type = event.type;
  const reviewKey = eventKey(event, fileKey);

  if (type === "model_call_completed") {
    if (!MODEL_CALL_KINDS.has(event.kind)) {
      state.source.invalidEvents += 1;
      return;
    }
    aggregateCompletedCall(state, event);
    incrementCorrelation(
      state.completedCallEvents,
      callEventKey(event, reviewKey),
      reviewKey,
    );
    if (
      AGENT_STREAM_CALL_KINDS.has(event.kind) &&
      event.errorCode === "AGENT_OUTPUT_LIMIT"
    ) {
      state.outputLimitCalls += 1;
      state.outputLimitReviews.add(reviewKey);
    }
    return;
  }

  if (type === "agent_output_warning") {
    if (
      !AGENT_STREAM_CALL_KINDS.has(event.kind) ||
      typeof event.agent !== "string" ||
      event.agent.length === 0
    ) {
      state.source.invalidEvents += 1;
      return;
    }
    if (state.outputWarningEvents >= REPORT_LIMITS.outputWarningEvents) {
      throw new Error("Output warning events exceed the report input limit.");
    }
    state.outputWarningEvents += 1;
    incrementCorrelation(
      state.outputWarningCallEvents,
      callEventKey(event, reviewKey),
      reviewKey,
    );
    return;
  }

  if (type === "review_budget_completed") {
    if (state.completedReviews.has(reviewKey)) return;
    if (state.completedReviews.size >= REPORT_LIMITS.completedReviews) {
      throw new Error("Completed reviews exceed the report input limit.");
    }
    state.completedReviews.add(reviewKey);
    const completion = isRecord(event.completion) ? event.completion : {};
    if (Array.isArray(completion.reasons)) {
      for (const reason of completion.reasons) {
        incrementReason(
          state.completionReasons,
          safeMetadata(reason) ?? "unknown",
        );
      }
    }
    const tokenUsage = isRecord(event.tokenUsage) ? event.tokenUsage : {};
    const status = ["reported", "partial", "unknown"].includes(
      tokenUsage.status,
    )
      ? tokenUsage.status
      : "unknown";
    increment(state.reviewTokenStatuses, status);
    return;
  }

  if (type === "model_call_skipped") {
    if (!OPTIONAL_CALL_KINDS.has(event.kind)) return;
    const reason = safeMetadata(event.reason) ?? "unknown";
    state.optionalSkipTotal += 1;
    incrementReason(state.optionalSkipReasons, reason);
    incrementReason(
      state.optionalSkipKindReasons,
      `${event.kind}\u0000${reason}`,
    );
    return;
  }

  state.source.ignoredEvents += 1;
}

function aggregateCompletedCall(state, event) {
  if (state.completedCalls >= REPORT_LIMITS.completedCalls) {
    throw new Error("Completed model calls exceed the report input limit.");
  }
  const identity = normalizeExecutionIdentity(event.executionIdentity);
  const agent = safeMetadata(event.agent);
  const kind = event.kind;
  const agentStreamCall = AGENT_STREAM_CALL_KINDS.has(kind);
  const normalPath = isNormalPathCall(event);
  const groupFields = {
    agent,
    kind,
    providerRoute: identity.providerRoute,
    requestedModel: identity.requestedModel,
    reportingStatus: identity.reportingStatus,
    reportedProvider: identity.reportedProvider,
    reportedModel: identity.reportedModel,
  };
  const key = JSON.stringify(Object.values(groupFields));
  let group = state.callGroups.get(key);
  if (!group) {
    if (state.callGroups.size >= REPORT_LIMITS.executionGroups) {
      throw new Error("Execution groups exceed the report input limit.");
    }
    group = {
      ...groupFields,
      calls: 0,
      normalPathCalls: 0,
      byteValues: createByteValues(),
      normalPathByteValues: createByteValues(),
      reportedUsageCalls: 0,
      unknownUsageCalls: 0,
    };
    state.callGroups.set(key, group);
  }

  state.completedCalls += 1;
  if (agentStreamCall) {
    state.outputSignalEligibleCalls += 1;
  }
  group.calls += 1;
  if (normalPath) group.normalPathCalls += 1;
  increment(state.identityStatuses, identity.reportingStatus);
  for (const keyName of ["messageBytes", "thoughtBytes", "outputBytes"]) {
    const value = nonNegativeNumber(event[keyName]);
    if (value === undefined) continue;
    group.byteValues[keyName].push(value);
    if (agentStreamCall) {
      state.agentStreamByteValues[keyName].push(value);
    }
    if (normalPath) {
      group.normalPathByteValues[keyName].push(value);
      if (agentStreamCall) {
        state.normalPathAgentStreamByteValues[keyName].push(value);
      }
    }
  }
  if (hasReportedUsage(event.usage)) {
    group.reportedUsageCalls += 1;
  } else {
    group.unknownUsageCalls += 1;
  }
}

function finalizeReport(state) {
  const completedReviews = state.completedReviews.size;
  const completedCalls = state.completedCalls;
  const warningCorrelation = correlateOutputWarnings(state);
  const groups = [...state.callGroups.values()]
    .map((group) => ({
      agent: group.agent,
      kind: group.kind,
      providerRoute: group.providerRoute,
      requestedModel: group.requestedModel,
      reportingStatus: group.reportingStatus,
      reportedProvider: group.reportedProvider,
      reportedModel: group.reportedModel,
      calls: group.calls,
      normalPathCalls: group.normalPathCalls,
      bytes: {
        allCalls: summarizeByteValues(group.byteValues),
        normalPath: summarizeByteValues(group.normalPathByteValues),
      },
      tokenUsage: {
        reportedCalls: group.reportedUsageCalls,
        unknownCalls: group.unknownUsageCalls,
        reportedRate: rate(group.reportedUsageCalls, group.calls),
        unknownRate: rate(group.unknownUsageCalls, group.calls),
      },
    }))
    .sort(compareExecutionGroups);

  return {
    schemaVersion: 1,
    inputLimits: REPORT_LIMITS,
    dataProvenance: {
      bytes: "measured_trace_fields",
      tokenUsage: "provider_reported_trace_fields",
      tokenEstimatesIncluded: false,
      costEstimatesIncluded: false,
    },
    source: state.source,
    reviews: {
      completed: completedReviews,
      completionReasons: countEntries(state.completionReasons, "reason"),
    },
    calls: {
      completed: completedCalls,
      outputSignalEligible: state.outputSignalEligibleCalls,
      normalPath: groups.reduce(
        (total, group) => total + group.normalPathCalls,
        0,
      ),
      identityReporting: Object.fromEntries(
        ["reported", "requested_only", "unknown", "missing"].map((status) => {
          const calls = state.identityStatuses.get(status) ?? 0;
          return [status, { calls, rate: rate(calls, completedCalls) }];
        }),
      ),
      byExecution: groups,
    },
    bytes: {
      allCalls: summarizeByteValues(state.agentStreamByteValues),
      normalPath: summarizeByteValues(state.normalPathAgentStreamByteValues),
    },
    tokenUsage: {
      reviewStatus: Object.fromEntries(
        ["reported", "partial", "unknown"].map((status) => {
          const reviews = state.reviewTokenStatuses.get(status) ?? 0;
          return [status, { reviews, rate: rate(reviews, completedReviews) }];
        }),
      ),
    },
    outputSignals: {
      agentOutputWarning: {
        events: state.outputWarningEvents,
        calls: warningCorrelation.calls,
        uncorrelatedEvents:
          state.outputWarningEvents - warningCorrelation.calls,
        callRate: rate(
          warningCorrelation.calls,
          state.outputSignalEligibleCalls,
        ),
        reviews: warningCorrelation.completedReviews,
        reviewRate: rate(warningCorrelation.completedReviews, completedReviews),
      },
      agentOutputLimit: {
        calls: state.outputLimitCalls,
        callRate: rate(state.outputLimitCalls, state.outputSignalEligibleCalls),
        reviews: intersectionSize(
          state.outputLimitReviews,
          state.completedReviews,
        ),
        reviewRate: rate(
          intersectionSize(state.outputLimitReviews, state.completedReviews),
          completedReviews,
        ),
      },
    },
    optionalPhaseSkips: {
      total: state.optionalSkipTotal,
      byReason: countEntries(state.optionalSkipReasons, "reason"),
      byKindAndReason: [...state.optionalSkipKindReasons.entries()]
        .map(([key, count]) => {
          const [kind, reason] = key.split("\u0000");
          return { kind, reason, count };
        })
        .sort((left, right) =>
          `${left.kind}\u0000${left.reason}`.localeCompare(
            `${right.kind}\u0000${right.reason}`,
            "en",
          ),
        ),
    },
  };
}

function normalizeExecutionIdentity(value) {
  if (!isRecord(value)) {
    return {
      providerRoute: null,
      requestedModel: null,
      reportingStatus: "missing",
      reportedProvider: null,
      reportedModel: null,
    };
  }
  const providerRoute = PROVIDER_ROUTES.has(value.providerRoute)
    ? value.providerRoute
    : null;
  const requestedModel = safeMetadata(value.requestedModel);
  const reportedProvider = safeMetadata(value.reportedProvider);
  const reportedModel = safeMetadata(value.reportedModel);
  const reportingStatus =
    reportedProvider !== null || reportedModel !== null
      ? "reported"
      : requestedModel !== null
        ? "requested_only"
        : "unknown";
  return {
    providerRoute,
    requestedModel,
    reportingStatus,
    reportedProvider,
    reportedModel,
  };
}

function safeMetadata(value) {
  if (typeof value !== "string") return null;
  const compact = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    compact.length === 0 ||
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(compact)) ||
    UNSAFE_METADATA_PATTERN.test(compact) ||
    compact.includes("[KYOSO_REDACTED]")
  ) {
    return null;
  }
  return compact.length <= MAX_METADATA_CHARS
    ? compact
    : `${compact.slice(0, MAX_METADATA_CHARS - 3)}...`;
}

function summarizeByteValues(values) {
  return {
    messageBytes: percentileSummary(values.messageBytes),
    thoughtBytes: percentileSummary(values.thoughtBytes),
    outputBytes: percentileSummary(values.outputBytes),
  };
}

function percentileSummary(values) {
  if (values.length === 0) {
    return { samples: 0, p50: null, p95: null, p99: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted.at(-1),
  };
}

function nearestRank(sorted, percentile) {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}

function hasReportedUsage(value) {
  if (!isRecord(value)) return false;
  return TOKEN_USAGE_KEYS.some(
    (key) => nonNegativeNumber(value[key]) !== undefined,
  );
}

function isNormalPathCall(event) {
  return event.resultStatus === "completed" && event.errorCode === undefined;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function countEntries(counts, label) {
  return [...counts.entries()]
    .map(([value, count]) => ({ [label]: value, count }))
    .sort((left, right) =>
      String(left[label]).localeCompare(String(right[label]), "en"),
    );
}

function compareExecutionGroups(left, right) {
  return [
    left.kind,
    left.agent ?? "",
    left.providerRoute ?? "",
    left.requestedModel ?? "",
    left.reportingStatus,
    left.reportedProvider ?? "",
    left.reportedModel ?? "",
  ]
    .join("\u0000")
    .localeCompare(
      [
        right.kind,
        right.agent ?? "",
        right.providerRoute ?? "",
        right.requestedModel ?? "",
        right.reportingStatus,
        right.reportedProvider ?? "",
        right.reportedModel ?? "",
      ].join("\u0000"),
      "en",
    );
}

function createByteValues() {
  return { messageBytes: [], thoughtBytes: [], outputBytes: [] };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementReason(map, key) {
  if (!map.has(key) && map.size >= REPORT_LIMITS.distinctReasons) {
    throw new Error("Distinct trace reasons exceed the report input limit.");
  }
  increment(map, key);
}

function incrementCorrelation(map, key, reviewKey) {
  const current = map.get(key);
  if (current) {
    current.count += 1;
    return;
  }
  if (map.size >= REPORT_LIMITS.correlationKeys) {
    throw new Error("Trace correlation keys exceed the report input limit.");
  }
  map.set(key, { count: 1, reviewKey });
}

function correlateOutputWarnings(state) {
  let calls = 0;
  const reviews = new Set();
  for (const [key, warning] of state.outputWarningCallEvents) {
    const completed = state.completedCallEvents.get(key);
    if (!completed) continue;
    const correlated = Math.min(warning.count, completed.count);
    calls += correlated;
    if (correlated > 0 && state.completedReviews.has(warning.reviewKey)) {
      reviews.add(warning.reviewKey);
    }
  }
  return { calls, completedReviews: reviews.size };
}

function rate(numerator, denominator) {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

function intersectionSize(left, right) {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function eventKey(event, fileKey) {
  const source =
    typeof event.traceId === "string" && event.traceId.length > 0
      ? event.traceId
      : `file:${fileKey}`;
  return opaqueKey(["review", source]);
}

function callEventKey(event, reviewKey) {
  return opaqueKey([
    "call",
    reviewKey,
    typeof event.kind === "string" ? event.kind : "",
    typeof event.agent === "string" ? event.agent : "",
  ]);
}

function opaqueKey(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part, "utf8")));
    hash.update(":");
    hash.update(part);
  }
  return hash.digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function* jsonlLines(contents) {
  let start = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== "\n") continue;
    const end =
      index > start && contents[index - 1] === "\r" ? index - 1 : index;
    yield contents.slice(start, end);
    start = index + 1;
  }
  if (start < contents.length) {
    const end = contents.endsWith("\r") ? contents.length - 1 : contents.length;
    yield contents.slice(start, end);
  }
}

function usage() {
  return `Usage: node scripts/review-budget-report.mjs --trace-dir <absolute-directory> [--json]\n\nReads only .jsonl files below the explicitly supplied directory. Byte distributions use nearest-rank percentiles; token and cost values are never estimated from bytes.`;
}

async function main() {
  const options = parseReportArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await buildReviewBudgetReport(options.traceDir);
  process.stdout.write(
    options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderHumanReport(report)}\n`,
  );
}

async function internalWorkerMain(argv) {
  if (
    argv.length !== 2 ||
    !/^[1-9][0-9]*$/.test(argv[0] ?? "") ||
    !/^[1-9][0-9]*$/.test(argv[1] ?? "")
  ) {
    throw new Error("The trace directory identity is invalid.");
  }
  const report = await buildAnchoredReviewBudgetReport({
    device: BigInt(argv[0]),
    inode: BigInt(argv[1]),
  });
  process.stdout.write(JSON.stringify(report));
}

if (isMainModule()) {
  const internalWorker = process.argv[2] === INTERNAL_WORKER_FLAG;
  const entrypoint = internalWorker
    ? internalWorkerMain(process.argv.slice(3))
    : main();
  entrypoint.catch((error) => {
    const rawMessage =
      error instanceof Error ? error.message : WORKER_FAILURE_MESSAGE;
    const message = internalWorker
      ? SAFE_WORKER_ERROR_MESSAGES.has(rawMessage)
        ? rawMessage
        : WORKER_FAILURE_MESSAGE
      : rawMessage;
    process.stderr.write(
      internalWorker
        ? `${message}\n`
        : `review-budget-report failed: ${message}\n`,
    );
    process.exitCode = 1;
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}
