#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { booleanFlag, parseArgs, stringArrayFlag, stringFlag } from "./args.js";
import { readPathOrText, readSelectedFiles } from "./io.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";
import { startMcpServer } from "../mcp/server.js";
import { runReview } from "../core/runReview.js";
import type {
  KyosoReviewRequest,
  NetworkMode,
  ReviewTool,
} from "../core/types.js";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const configPath = stringFlag(parsed.flags, "config");
  const ignoreConfig = booleanFlag(parsed.flags, "ignore-config");

  if (parsed.command === "mcp") {
    const network = networkFlag(parsed.flags);
    await startMcpServer({
      cwd,
      configPath,
      ignoreConfig,
      mcpNetworkMode: network,
    });
    return;
  }

  if (parsed.command === "doctor") {
    console.log(await runDoctor({ cwd, configPath, ignoreConfig }));
    return;
  }

  if (parsed.command === "init") {
    console.log(
      await runInit({ cwd, force: booleanFlag(parsed.flags, "force") }),
    );
    return;
  }

  if (
    parsed.command === "plan" ||
    parsed.command === "security" ||
    parsed.command === "diff"
  ) {
    const tool = commandToTool(parsed.command);
    const request = await buildReviewRequest(tool, parsed.flags);
    const result = await runReview(tool, request, {
      cwd,
      configPath,
      ignoreConfig,
    });
    console.log(
      booleanFlag(parsed.flags, "json")
        ? JSON.stringify(result, null, 2)
        : result.summaryMarkdown,
    );
    return;
  }

  console.log(HELP);
}

async function buildReviewRequest(
  tool: ReviewTool,
  flags: Record<string, string | boolean | string[]>,
): Promise<KyosoReviewRequest> {
  const goal = stringFlag(flags, "goal") ?? defaultGoal(tool);
  const repoSummary = await readPathOrText(stringFlag(flags, "repo-summary"));
  const currentPlan = await readPathOrText(stringFlag(flags, "plan"));
  const selectedFiles = await readSelectedFiles(stringArrayFlag(flags, "file"));
  const diffInput = await buildDiff(tool, flags);
  const network = networkFlag(flags);
  const options: NonNullable<KyosoReviewRequest["options"]> = {
    allowSecretRedaction: booleanFlag(flags, "allow-secret-redaction"),
  };
  if (network) {
    options.network = network;
  }
  return {
    goal,
    repoSummary,
    currentPlan,
    selectedFiles: selectedFiles.length > 0 ? selectedFiles : undefined,
    diff: diffInput,
    constraints: stringArrayFlag(flags, "constraint"),
    options,
  };
}

async function buildDiff(
  tool: ReviewTool,
  flags: Record<string, string | boolean | string[]>,
): Promise<KyosoReviewRequest["diff"]> {
  const diffPathOrText = stringFlag(flags, "diff");
  if (diffPathOrText) {
    return {
      baseRef: stringFlag(flags, "base"),
      headRef: stringFlag(flags, "head"),
      unifiedDiff: (await readPathOrText(diffPathOrText)) ?? "",
    };
  }
  if (tool !== "diff_review") return undefined;

  const base = stringFlag(flags, "base") ?? "main";
  const head = stringFlag(flags, "head") ?? "HEAD";
  const result = spawnSync("git", ["diff", base, head], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git diff failed for ${base}..${head}`);
  }
  return { baseRef: base, headRef: head, unifiedDiff: result.stdout };
}

function commandToTool(command: string): ReviewTool {
  if (command === "plan") return "plan_review";
  if (command === "security") return "security_review";
  return "diff_review";
}

function defaultGoal(tool: ReviewTool): string {
  if (tool === "plan_review") return "Review the supplied implementation plan.";
  if (tool === "security_review")
    return "Review the supplied context with CISA Secure by Design criteria.";
  return "Review the supplied unified diff.";
}

function networkFlag(
  flags: Record<string, string | boolean | string[]>,
): NetworkMode | undefined {
  if (flags.network === true) {
    throw new Error(
      "Missing value for --network. Expected model_only or unrestricted.",
    );
  }
  return parseNetworkFlag(stringFlag(flags, "network"));
}

function parseNetworkFlag(value: string | undefined): NetworkMode | undefined {
  if (value === undefined) return undefined;
  if (value === "model_only" || value === "unrestricted") return value;
  throw new Error(
    `Invalid --network value "${value}". Expected model_only or unrestricted.`,
  );
}

const HELP = `Kyoso

Usage:
  kyoso mcp [--config kyoso.config.ts] [--ignore-config] [--network model_only|unrestricted]
  kyoso plan --goal <text> [--plan <path-or-text>] [--file <path>] [--json]
  kyoso security --goal <text> [--diff <path>] [--file <path>] [--allow-secret-redaction]
  kyoso diff --base main --head HEAD [--json]
  kyoso doctor
  kyoso init [--force]
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
