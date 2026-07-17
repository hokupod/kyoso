import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  symlink,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// @ts-expect-error The report is intentionally shipped as a standalone Node.js script.
import * as reportModule from "../../scripts/review-budget-report.mjs";

const {
  buildReviewBudgetReport,
  inspectTraceRoot,
  parseReportArgs,
  renderHumanReport,
  REPORT_LIMITS,
} = reportModule;

describe("review budget report", () => {
  test("aggregates execution groups, distributions, rates, and reasons", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-report-"));
    const nested = join(traceDir, "2026-07-16");
    await mkdir(nested, { recursive: true });
    await writeJsonl(join(traceDir, "first.jsonl"), [
      {
        type: "model_call_completed",
        traceId: "tr_first",
        kind: "primary",
        agent: "codex",
        resultStatus: "completed",
        messageBytes: 10,
        thoughtBytes: 20,
        outputBytes: 30,
        usage: { totalTokens: 12 },
        executionIdentity: {
          providerRoute: "openrouter",
          requestedModel: "openai/o4-mini",
          reportingStatus: "requested_only",
        },
      },
      {
        type: "agent_output_warning",
        traceId: "tr_first",
        kind: "primary",
        agent: "codex",
      },
      {
        type: "model_call_completed",
        traceId: "tr_first",
        kind: "verifier",
        agent: "claude",
        resultStatus: "failed",
        messageBytes: 30,
        thoughtBytes: 10,
        outputBytes: 40,
        errorCode: "AGENT_OUTPUT_LIMIT",
        executionIdentity: {
          providerRoute: "claude_default",
          requestedModel: "claude-requested",
          reportedProvider: "anthropic",
          reportedModel: "claude-reported",
          reportingStatus: "reported",
        },
      },
      {
        type: "model_call_skipped",
        traceId: "tr_first",
        kind: "verifier",
        agent: "claude",
        reason: "token_usage_unknown",
      },
      {
        type: "review_budget_completed",
        traceId: "tr_first",
        completion: {
          status: "incomplete",
          reasons: ["coverage_incomplete", "token_usage_unknown"],
        },
        tokenUsage: { status: "partial" },
      },
      { type: "config_loaded", traceId: "tr_first" },
      "{not-json",
    ]);
    await writeJsonl(join(nested, "second.jsonl"), [
      {
        type: "model_call_completed",
        traceId: "tr_second",
        kind: "judge",
        resultStatus: "completed",
        messageBytes: 0,
        thoughtBytes: 0,
        outputBytes: 0,
        usage: { inputTokens: 5, outputTokens: 3 },
        executionIdentity: {
          providerRoute: "openai",
          requestedModel: "gpt-requested",
          reportedModel: "gpt-reported",
          reportingStatus: "reported",
        },
      },
      {
        type: "agent_output_warning",
        traceId: "tr_second",
        kind: "judge",
        agent: "judge",
      },
      {
        type: "model_call_skipped",
        traceId: "tr_second",
        kind: "judge",
        reason: "model_call_budget",
      },
      {
        type: "review_budget_completed",
        traceId: "tr_second",
        completion: { status: "complete", reasons: [] },
        tokenUsage: { status: "reported" },
      },
    ]);
    await writeFile(
      join(traceDir, "ignored.txt"),
      `${JSON.stringify({ type: "model_call_completed" })}\n`,
      "utf8",
    );

    const report = await buildReviewBudgetReport(traceDir);

    expect(report.dataProvenance).toEqual({
      bytes: "measured_trace_fields",
      tokenUsage: "provider_reported_trace_fields",
      tokenEstimatesIncluded: false,
      costEstimatesIncluded: false,
    });
    expect(report.source).toMatchObject({
      jsonlFiles: 2,
      jsonlLines: 11,
      directories: 2,
      malformedLines: 1,
      ignoredEvents: 1,
      invalidEvents: 1,
      skippedSymlinks: 0,
    });
    expect(report.source.jsonlBytes).toBeGreaterThan(0);
    expect(report.inputLimits).toEqual(REPORT_LIMITS);
    expect(report.reviews).toEqual({
      completed: 2,
      completionReasons: [
        { reason: "coverage_incomplete", count: 1 },
        { reason: "token_usage_unknown", count: 1 },
      ],
    });
    expect(report.calls.completed).toBe(3);
    expect(report.calls.outputSignalEligible).toBe(2);
    expect(report.calls.normalPath).toBe(2);
    expect(report.calls.identityReporting).toEqual({
      reported: { calls: 2, rate: 0.666667 },
      requested_only: { calls: 1, rate: 0.333333 },
      unknown: { calls: 0, rate: 0 },
      missing: { calls: 0, rate: 0 },
    });
    expect(report.calls.byExecution).toHaveLength(3);
    expect(report.calls.byExecution).toContainEqual(
      expect.objectContaining({
        agent: "codex",
        kind: "primary",
        providerRoute: "openrouter",
        requestedModel: "openai/o4-mini",
        reportingStatus: "requested_only",
        reportedProvider: null,
        reportedModel: null,
        calls: 1,
        tokenUsage: {
          reportedCalls: 1,
          unknownCalls: 0,
          reportedRate: 1,
          unknownRate: 0,
        },
      }),
    );
    expect(report.calls.byExecution).toContainEqual(
      expect.objectContaining({
        agent: "claude",
        kind: "verifier",
        reportingStatus: "reported",
        reportedProvider: "anthropic",
        reportedModel: "claude-reported",
        normalPathCalls: 0,
        bytes: {
          allCalls: {
            messageBytes: { samples: 1, p50: 30, p95: 30, p99: 30, max: 30 },
            thoughtBytes: { samples: 1, p50: 10, p95: 10, p99: 10, max: 10 },
            outputBytes: { samples: 1, p50: 40, p95: 40, p99: 40, max: 40 },
          },
          normalPath: {
            messageBytes: {
              samples: 0,
              p50: null,
              p95: null,
              p99: null,
              max: null,
            },
            thoughtBytes: {
              samples: 0,
              p50: null,
              p95: null,
              p99: null,
              max: null,
            },
            outputBytes: {
              samples: 0,
              p50: null,
              p95: null,
              p99: null,
              max: null,
            },
          },
        },
        tokenUsage: {
          reportedCalls: 0,
          unknownCalls: 1,
          reportedRate: 0,
          unknownRate: 1,
        },
      }),
    );
    expect(report.bytes).toEqual({
      allCalls: {
        messageBytes: { samples: 2, p50: 10, p95: 30, p99: 30, max: 30 },
        thoughtBytes: { samples: 2, p50: 10, p95: 20, p99: 20, max: 20 },
        outputBytes: { samples: 2, p50: 30, p95: 40, p99: 40, max: 40 },
      },
      normalPath: {
        messageBytes: { samples: 1, p50: 10, p95: 10, p99: 10, max: 10 },
        thoughtBytes: { samples: 1, p50: 20, p95: 20, p99: 20, max: 20 },
        outputBytes: { samples: 1, p50: 30, p95: 30, p99: 30, max: 30 },
      },
    });
    expect(report.tokenUsage.reviewStatus).toEqual({
      reported: { reviews: 1, rate: 0.5 },
      partial: { reviews: 1, rate: 0.5 },
      unknown: { reviews: 0, rate: 0 },
    });
    expect(report.outputSignals).toEqual({
      agentOutputWarning: {
        events: 1,
        calls: 1,
        uncorrelatedEvents: 0,
        callRate: 0.5,
        reviews: 1,
        reviewRate: 0.5,
      },
      agentOutputLimit: {
        calls: 1,
        callRate: 0.5,
        reviews: 1,
        reviewRate: 0.5,
      },
    });
    expect(renderHumanReport(report)).toContain(
      "Correlated output-warning calls: 1",
    );
    expect(report.optionalPhaseSkips).toEqual({
      total: 2,
      byReason: [
        { reason: "model_call_budget", count: 1 },
        { reason: "token_usage_unknown", count: 1 },
      ],
      byKindAndReason: [
        { kind: "judge", reason: "model_call_budget", count: 1 },
        { kind: "verifier", reason: "token_usage_unknown", count: 1 },
      ],
    });
  });

  test("correlates output warnings with completed calls", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-warning-"));
    await writeJsonl(join(traceDir, "warnings.jsonl"), [
      {
        type: "agent_output_warning",
        traceId: "tr_matched",
        kind: "primary",
        agent: "codex",
      },
      {
        type: "agent_output_warning",
        traceId: "tr_matched",
        kind: "primary",
        agent: "codex",
      },
      {
        type: "agent_output_warning",
        traceId: "tr_orphan",
        kind: "primary",
        agent: "codex",
      },
      {
        type: "model_call_completed",
        traceId: "tr_matched",
        kind: "primary",
        agent: "codex",
        resultStatus: "completed",
      },
      {
        type: "model_call_completed",
        traceId: "tr_unwarned",
        kind: "primary",
        agent: "claude",
        resultStatus: "completed",
      },
      {
        type: "review_budget_completed",
        traceId: "tr_matched",
        completion: { status: "complete", reasons: [] },
      },
      {
        type: "review_budget_completed",
        traceId: "tr_unwarned",
        completion: { status: "complete", reasons: [] },
      },
    ]);

    const report = await buildReviewBudgetReport(traceDir);

    expect(report.outputSignals.agentOutputWarning).toEqual({
      events: 3,
      calls: 1,
      uncorrelatedEvents: 2,
      callRate: 0.5,
      reviews: 1,
      reviewRate: 0.5,
    });
  });

  test("returns stable empty distributions for an empty directory", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-empty-"));

    const report = await buildReviewBudgetReport(traceDir);

    expect(report.source.jsonlFiles).toBe(0);
    expect(report.reviews.completed).toBe(0);
    expect(report.calls.completed).toBe(0);
    expect(report.calls.outputSignalEligible).toBe(0);
    expect(report.calls.byExecution).toEqual([]);
    expect(report.bytes.normalPath.outputBytes).toEqual({
      samples: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
    expect(report.tokenUsage.reviewStatus.unknown).toEqual({
      reviews: 0,
      rate: 0,
    });
  });

  test("reads only regular jsonl files below the explicit directory", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "kyoso-budget-outside-"));
    const canary = join(outside, "canary.jsonl");
    const canaryContents = `${JSON.stringify({
      type: "model_call_completed",
      traceId: "tr_outside",
      kind: "primary",
      outputBytes: 99,
    })}\n`;
    await writeFile(canary, canaryContents, "utf8");
    await symlink(canary, join(traceDir, "outside.jsonl"));

    const beforeEntries = await readdir(traceDir);
    const report = await buildReviewBudgetReport(traceDir);

    expect(report.source).toMatchObject({
      jsonlFiles: 0,
      skippedSymlinks: 1,
    });
    expect(report.calls.completed).toBe(0);
    expect(await readFile(canary, "utf8")).toBe(canaryContents);
    expect(await readdir(traceDir)).toEqual(beforeEntries);
  });

  test("rejects same-size trace rewrites after discovery", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-rewrite-"));
    const tracePath = join(traceDir, "trace.jsonl");
    const original = `${JSON.stringify({
      type: "model_call_completed",
      traceId: "tr_rewrite",
      kind: "primary",
      outputBytes: 10,
    })}\n`;
    const replacement = original.replace(
      '"outputBytes":10',
      '"outputBytes":20',
    );
    expect(replacement).toHaveLength(original.length);
    await writeFile(tracePath, original, "utf8");
    const discoveredFile = await traceFileIdentity("trace.jsonl", tracePath);

    await writeFile(tracePath, replacement, "utf8");
    const rewriteTime = new Date(Date.now() + 2_000);
    await utimes(tracePath, rewriteTime, rewriteTime);

    const child = readTraceFileInChild(
      traceDir,
      discoveredFile,
      "changed after discovery",
    );
    if (child.error) throw child.error;
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });

  test("rejects FIFO replacements without blocking", async () => {
    if (process.platform === "win32") return;

    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-fifo-"));
    const tracePath = join(traceDir, "trace.jsonl");
    await writeJsonl(tracePath, [
      {
        type: "model_call_completed",
        traceId: "tr_fifo",
        kind: "primary",
        agent: "codex",
        resultStatus: "completed",
      },
    ]);
    const discoveredFile = await traceFileIdentity("trace.jsonl", tracePath);

    await unlink(tracePath);
    const mkfifo = spawnSync("mkfifo", [tracePath], { encoding: "utf8" });
    if (mkfifo.error) throw mkfifo.error;
    if (mkfifo.status !== 0) {
      throw new Error(mkfifo.stderr || "mkfifo failed");
    }

    const child = readTraceFileInChild(
      traceDir,
      discoveredFile,
      "changed after discovery",
    );

    if (child.error) throw child.error;
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
  });

  test("rejects trace root replacement during validation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "kyoso-budget-root-race-"));
    const traceDir = join(parent, "traces");
    const movedTraceDir = join(parent, "moved-traces");
    const outside = join(parent, "outside");
    const canary = join(outside, "canary.jsonl");
    const canaryContents = `${JSON.stringify({
      type: "model_call_completed",
      traceId: "tr_outside",
      kind: "primary",
      outputBytes: 99,
    })}\n`;
    await mkdir(traceDir);
    await mkdir(outside);
    await writeFile(canary, canaryContents, "utf8");

    let replaced = false;
    const fileSystem = {
      lstat,
      open: async (path: string, flags: number) => {
        if (!replaced && path === traceDir) {
          replaced = true;
          await rename(traceDir, movedTraceDir);
          await symlink(outside, traceDir);
        }
        return open(path, flags);
      },
    };

    await expect(inspectTraceRoot(traceDir, fileSystem)).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(await readFile(canary, "utf8")).toBe(canaryContents);
  });

  test("keeps traversal anchored through trace-root ABA replacement", async () => {
    if (process.platform === "win32") return;

    const parent = await mkdtemp(join(tmpdir(), "kyoso-budget-root-aba-"));
    const traceDir = join(parent, "traces");
    const movedTraceDir = join(parent, "moved-traces");
    const alternateDir = join(parent, "alternate");
    const displacedAlternateDir = join(parent, "displaced-alternate");
    await mkdir(traceDir);
    await mkdir(alternateDir);
    await writeJsonl(join(traceDir, "safe.jsonl"), [
      {
        type: "model_call_completed",
        traceId: "tr_safe",
        kind: "primary",
        agent: "codex",
        resultStatus: "completed",
        outputBytes: 10,
      },
    ]);
    const alternateTrace = join(alternateDir, "alternate.jsonl");
    const alternateContents = `${JSON.stringify({
      type: "model_call_completed",
      traceId: "tr_alternate",
      kind: "primary",
      agent: "codex",
      resultStatus: "completed",
      outputBytes: 99,
    })}\n`;
    await writeFile(alternateTrace, alternateContents, "utf8");

    const rootInfo = await lstat(traceDir, { bigint: true });
    const moduleUrl = pathToFileURL(
      resolve("scripts/review-budget-report.mjs"),
    ).href;
    const childScript = `
      const { rename } = await import("node:fs/promises");
      const { buildAnchoredReviewBudgetReport } = await import(${JSON.stringify(moduleUrl)});
      await rename(${JSON.stringify(traceDir)}, ${JSON.stringify(movedTraceDir)});
      await rename(${JSON.stringify(alternateDir)}, ${JSON.stringify(traceDir)});
      let report;
      try {
        report = await buildAnchoredReviewBudgetReport({
          device: BigInt(${JSON.stringify(String(rootInfo.dev))}),
          inode: BigInt(${JSON.stringify(String(rootInfo.ino))}),
        });
      } finally {
        await rename(${JSON.stringify(traceDir)}, ${JSON.stringify(displacedAlternateDir)});
        await rename(${JSON.stringify(movedTraceDir)}, ${JSON.stringify(traceDir)});
      }
      process.stdout.write(JSON.stringify(report));
    `;
    const child = spawnSync(
      "node",
      ["--input-type=module", "--eval", childScript],
      {
        cwd: traceDir,
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );

    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(child.stderr || "ABA child failed");
    const report = JSON.parse(child.stdout);
    expect(report.source.jsonlFiles).toBe(1);
    expect(report.calls.completed).toBe(1);
    expect(report.bytes.allCalls.outputBytes.max).toBe(10);
    expect(
      await readFile(
        alternateTrace.replace(alternateDir, displacedAlternateDir),
        "utf8",
      ),
    ).toBe(alternateContents);
  });

  test("sanitizes untrusted metadata before emitting groups and reasons", async () => {
    const traceDir = await mkdtemp(join(tmpdir(), "kyoso-budget-metadata-"));
    const secretLike = `sk-${"a".repeat(20)}`;
    const fineGrainedTokens = {
      agent: ["github", "_pat_", "i".repeat(24)].join(""),
      requestedModel: ["github", "_pat_", "j".repeat(24)].join(""),
      reportedProvider: ["github", "_pat_", "k".repeat(24)].join(""),
      reportedModel: ["github", "_pat_", "l".repeat(24)].join(""),
      reason: ["github", "_pat_", "m".repeat(24)].join(""),
    };
    const credentialLikeValues = [
      secretLike,
      ...Object.values(fineGrainedTokens),
      `ASIA${"A".repeat(16)}`,
      `AIza${"a".repeat(35)}`,
      `glpat-${"b".repeat(20)}`,
      `npm_${"c".repeat(24)}`,
      `pypi-${"d".repeat(24)}`,
      `eyJ${"e".repeat(12)}.${"f".repeat(12)}.${"g".repeat(12)}`,
      `Bearer ${"h".repeat(24)}`,
      ["-----", "BEGIN PRIVATE KEY", "-----"].join(""),
    ];
    const urlLike = "https://example.invalid/model";
    const ansiModel = "reported\u001b[31m-model";
    const longModel = `model-${"x".repeat(200)}`;
    await writeJsonl(join(traceDir, "metadata.jsonl"), [
      {
        type: "model_call_completed",
        traceId: "tr_metadata",
        kind: "primary",
        agent: "codex",
        resultStatus: "completed",
        executionIdentity: {
          providerRoute: "openrouter",
          requestedModel: secretLike,
          reportedProvider: urlLike,
          reportedModel: ansiModel,
        },
      },
      {
        type: "model_call_completed",
        traceId: "tr_fine_grained_metadata",
        kind: "primary",
        agent: fineGrainedTokens.agent,
        resultStatus: "completed",
        executionIdentity: {
          providerRoute: "anthropic",
          requestedModel: fineGrainedTokens.requestedModel,
          reportedProvider: fineGrainedTokens.reportedProvider,
          reportedModel: fineGrainedTokens.reportedModel,
        },
      },
      {
        type: "model_call_completed",
        traceId: "tr_metadata",
        kind: "judge",
        resultStatus: "completed",
        executionIdentity: {
          providerRoute: "openai",
          requestedModel: longModel,
        },
      },
      {
        type: "model_call_skipped",
        traceId: "tr_metadata",
        kind: "verifier",
        reason: secretLike,
      },
      ...credentialLikeValues.slice(1).map((value, index) => ({
        type: "model_call_skipped",
        traceId: `tr_metadata_${index}`,
        kind: "verifier",
        reason: value,
      })),
    ]);

    const report = await buildReviewBudgetReport(traceDir);
    const serialized = JSON.stringify(report);
    const reportedGroup = report.calls.byExecution.find(
      (group: { providerRoute: string }) =>
        group.providerRoute === "openrouter",
    );
    const longModelGroup = report.calls.byExecution.find(
      (group: { providerRoute: string }) => group.providerRoute === "openai",
    );
    const fineGrainedGroup = report.calls.byExecution.find(
      (group: { providerRoute: string }) => group.providerRoute === "anthropic",
    );

    for (const credentialLike of credentialLikeValues) {
      expect(serialized).not.toContain(credentialLike);
    }
    expect(serialized).not.toContain(urlLike);
    expect(serialized).not.toContain("\u001b");
    expect(reportedGroup).toMatchObject({
      requestedModel: null,
      reportedProvider: null,
      reportedModel: "reported-model",
      reportingStatus: "reported",
    });
    expect(longModelGroup.requestedModel).toHaveLength(160);
    expect(longModelGroup.requestedModel).toEndWith("...");
    expect(fineGrainedGroup).toMatchObject({
      agent: null,
      requestedModel: null,
      reportedProvider: null,
      reportedModel: null,
      reportingStatus: "unknown",
    });
    expect(report.optionalPhaseSkips.byReason).toEqual([
      { reason: "unknown", count: credentialLikeValues.length },
    ]);
  });

  test("requires an explicit absolute trace directory", () => {
    expect(() => parseReportArgs(["--json"])).toThrow(
      "--trace-dir is required",
    );
    expect(() =>
      parseReportArgs(["--trace-dir", "relative/traces", "--json"]),
    ).toThrow("--trace-dir must be an absolute path");
    expect(parseReportArgs(["--trace-dir", "/tmp/traces", "--json"])).toEqual({
      help: false,
      json: true,
      traceDir: "/tmp/traces",
    });
  });

  test("documents the installed bin without mutable package resolution", async () => {
    const documentationPaths = [
      "README.md",
      "README.ja.md",
      "README.zh-CN.md",
      "docs/kyoso_detailed_design.md",
    ];
    const installedCommand =
      "kyoso-budget-report --trace-dir /absolute/path/to/traces --json";
    const mutableCommand =
      "npx --yes --package @kyo-so/cli kyoso-budget-report";

    for (const path of documentationPaths) {
      const contents = await readFile(resolve(path), "utf8");
      expect(contents).toContain(installedCommand);
      expect(contents).not.toContain(mutableCommand);
    }
  });

  test("rejects trace inputs that exceed hard memory bounds", async () => {
    const oversizedFileDir = await mkdtemp(
      join(tmpdir(), "kyoso-budget-file-limit-"),
    );
    const oversizedFile = join(oversizedFileDir, "oversized.jsonl");
    await writeFile(oversizedFile, "", "utf8");
    await truncate(oversizedFile, REPORT_LIMITS.traceFileBytes + 1);

    await expect(buildReviewBudgetReport(oversizedFileDir)).rejects.toThrow(
      "per-file byte limit",
    );

    const oversizedLineDir = await mkdtemp(
      join(tmpdir(), "kyoso-budget-line-limit-"),
    );
    await writeFile(
      join(oversizedLineDir, "oversized-line.jsonl"),
      `${"x".repeat(REPORT_LIMITS.jsonlLineBytes + 1)}\n`,
      "utf8",
    );

    await expect(buildReviewBudgetReport(oversizedLineDir)).rejects.toThrow(
      "JSONL line exceeds",
    );

    const excessiveLinesDir = await mkdtemp(
      join(tmpdir(), "kyoso-budget-lines-limit-"),
    );
    await writeFile(
      join(excessiveLinesDir, "excessive-lines.jsonl"),
      "\n".repeat(REPORT_LIMITS.jsonlLines + 1),
      "utf8",
    );

    await expect(buildReviewBudgetReport(excessiveLinesDir)).rejects.toThrow(
      "JSONL lines exceed",
    );
  });
});

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  const lines = values.map((value) =>
    typeof value === "string" ? value : JSON.stringify(value),
  );
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
}

async function traceFileIdentity(name: string, path: string) {
  const info = await lstat(path, { bigint: true });
  return {
    name,
    key: name,
    size: Number(info.size),
    device: info.dev,
    inode: info.ino,
    modifiedAtNs: info.mtimeNs,
    changedAtNs: info.ctimeNs,
  };
}

function readTraceFileInChild(
  traceDir: string,
  file: Awaited<ReturnType<typeof traceFileIdentity>>,
  expectedMessage: string,
) {
  const moduleUrl = pathToFileURL(
    resolve("scripts/review-budget-report.mjs"),
  ).href;
  const serializedFile = JSON.stringify({
    ...file,
    device: String(file.device),
    inode: String(file.inode),
    modifiedAtNs: String(file.modifiedAtNs),
    changedAtNs: String(file.changedAtNs),
  });
  const childScript = `
    const { readBoundedTraceFile } = await import(${JSON.stringify(moduleUrl)});
    const serialized = JSON.parse(${JSON.stringify(serializedFile)});
    const file = {
      ...serialized,
      device: BigInt(serialized.device),
      inode: BigInt(serialized.inode),
      modifiedAtNs: BigInt(serialized.modifiedAtNs),
      changedAtNs: BigInt(serialized.changedAtNs),
    };
    try {
      await readBoundedTraceFile(file);
      process.exitCode = 2;
    } catch (error) {
      if (!String(error?.message).includes(${JSON.stringify(expectedMessage)})) {
        console.error(error);
        process.exitCode = 3;
      }
    }
  `;
  return spawnSync("node", ["--input-type=module", "--eval", childScript], {
    cwd: traceDir,
    encoding: "utf8",
    timeout: 2_000,
  });
}
