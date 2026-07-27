import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  repositoryRoot,
  verifyPluginDistribution,
} from "./plugin-distribution.mjs";
import { compareSemver } from "./plugin-promote.mjs";

const reminderTitlePrefix = "Plugin promotion needed: CLI v";
const reminderMarkerPrefix = "<!-- kyoso:plugin-promotion-reminder";
const reminderTitlePattern =
  /^Plugin promotion needed: CLI v(\S+) released, plugins pin v(\S+)$/;
const reminderMarkerPattern =
  /^<!-- kyoso:plugin-promotion-reminder cli=(\S+) -->$/;
const completeSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  runPluginPromotionIssueReconciliation().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export function parsePromotionReminderIssue(issue) {
  if (!isObject(issue)) {
    throw new Error("GitHub returned a non-object issue");
  }
  if (issue.pull_request) return undefined;
  if (typeof issue.title !== "string") {
    throw new Error("GitHub returned an issue without a string title");
  }

  const body = typeof issue.body === "string" ? issue.body : "";
  const markerCount = body.split(reminderMarkerPrefix).length - 1;
  if (!issue.title.startsWith(reminderTitlePrefix) || markerCount === 0) {
    return undefined;
  }

  const label = formatIssueLabel(issue.number);
  if (markerCount !== 1) {
    throw new Error(
      `${label} must contain exactly one Plugin promotion reminder marker`,
    );
  }

  const titleMatch = reminderTitlePattern.exec(issue.title);
  if (!titleMatch) {
    throw new Error(`${label} has a malformed Plugin promotion reminder title`);
  }
  const [, titleTarget, titlePin] = titleMatch;
  assertCompleteSemver(titleTarget, `${label} title target`);
  assertCompleteSemver(titlePin, `${label} title pin`);

  const markerLine = body
    .split(/\r?\n/)
    .find((line) => line.includes(reminderMarkerPrefix));
  const markerMatch = markerLine
    ? reminderMarkerPattern.exec(markerLine)
    : undefined;
  if (!markerMatch) {
    throw new Error(
      `${label} has a malformed Plugin promotion reminder marker`,
    );
  }
  const markerTarget = markerMatch[1];
  assertCompleteSemver(markerTarget, `${label} marker target`);
  if (markerTarget !== titleTarget) {
    throw new Error(
      `${label} marker target (${markerTarget}) must match title target (${titleTarget})`,
    );
  }
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) {
    throw new Error(`${label} must have a positive integer issue number`);
  }

  return {
    number: issue.number,
    title: issue.title,
    targetVersion: markerTarget,
  };
}

export function selectClosablePromotionReminderIssues(issues, currentPin) {
  if (!Array.isArray(issues)) {
    throw new Error("GitHub open issues response must be an array");
  }
  assertCompleteSemver(currentPin, "Current verified Plugin pin");

  return issues
    .map((issue) => parsePromotionReminderIssue(issue))
    .filter(
      (issue) =>
        issue !== undefined &&
        compareSemver(issue.targetVersion, currentPin) <= 0,
    )
    .sort((left, right) => left.number - right.number);
}

export async function runPluginPromotionIssueReconciliation(
  options = {},
  {
    verifyDistribution = verifyPluginDistribution,
    listOpenIssues = listOpenGitHubIssues,
    closeIssue = closeGitHubIssue,
    log = console.log,
  } = {},
) {
  const root = options.root ?? repositoryRoot;
  const packageMetadata = readJson(join(root, "package.json"), "package.json");
  const expectedPackageVersion = packageMetadata.version;
  assertCompleteSemver(expectedPackageVersion, "package.json version");

  const distribution = await verifyDistribution({
    root,
    verifyPackageArchive: false,
    expectedPackageVersion,
  });
  if (!isObject(distribution)) {
    throw new Error("Plugin distribution verification returned no result");
  }
  const currentPin = distribution.packageVersion;
  const pluginVersion = distribution.pluginVersion;
  assertCompleteSemver(currentPin, "Verified Plugin pin");
  assertCompleteSemver(pluginVersion, "Verified Plugin version");
  if (currentPin !== expectedPackageVersion) {
    throw new Error(
      `Verified Plugin pin (${currentPin}) must match package.json version (${expectedPackageVersion})`,
    );
  }

  const context = readActionsContext(options.env ?? process.env);
  const issues = await listOpenIssues({ repository: context.repository });
  const closable = selectClosablePromotionReminderIssues(issues, currentPin);
  const comment = buildAuditComment({
    context,
    currentPin,
    pluginVersion,
  });
  const closures = closable.map((issue) => ({
    issue,
    comment,
  }));

  for (const closure of closures) {
    await closeIssue({
      repository: context.repository,
      number: closure.issue.number,
      comment: closure.comment,
    });
    log(`Closed Plugin promotion reminder #${closure.issue.number}`);
  }
  if (closures.length === 0) {
    log("No resolved Plugin promotion reminder issues found");
  }

  return {
    currentPin,
    pluginVersion,
    closed: closures.map(({ issue }) => issue.number),
  };
}

function readActionsContext(env) {
  const repository = requireEnvironmentValue(env, "GITHUB_REPOSITORY");
  const sha = requireEnvironmentValue(env, "GITHUB_SHA");
  const serverUrl = requireEnvironmentValue(env, "GITHUB_SERVER_URL");
  const runId = requireEnvironmentValue(env, "GITHUB_RUN_ID");

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be an owner/repository slug");
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("GITHUB_SHA must be a complete 40-character commit SHA");
  }
  if (!/^[1-9]\d*$/.test(runId)) {
    throw new Error("GITHUB_RUN_ID must be a positive integer");
  }

  let parsedServerUrl;
  try {
    parsedServerUrl = new URL(serverUrl);
  } catch {
    throw new Error("GITHUB_SERVER_URL must be a valid HTTPS origin");
  }
  if (
    parsedServerUrl.protocol !== "https:" ||
    parsedServerUrl.username ||
    parsedServerUrl.password ||
    parsedServerUrl.pathname !== "/" ||
    parsedServerUrl.search ||
    parsedServerUrl.hash
  ) {
    throw new Error("GITHUB_SERVER_URL must be a valid HTTPS origin");
  }

  return {
    repository,
    sha: sha.toLowerCase(),
    runUrl: `${parsedServerUrl.origin}/${repository}/actions/runs/${runId}`,
  };
}

function buildAuditComment({ context, currentPin, pluginVersion }) {
  return [
    `Plugin promotion verification completed on \`${context.sha}\`.`,
    "",
    `- Plugin version: \`${pluginVersion}\``,
    `- Codex MCP pin: \`@kyo-so/cli@${currentPin}\``,
    `- Claude Code MCP pin: \`@kyo-so/cli@${currentPin}\``,
    `- Workflow run: ${context.runUrl}`,
  ].join("\n");
}

function listOpenGitHubIssues({ repository }) {
  const output = runGh([
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${repository}/issues`,
    "-f",
    "state=open",
    "-f",
    "per_page=100",
  ]);
  const pages = parseJson(output, "GitHub open issues response");
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(
      "GitHub open issues response must contain paginated arrays",
    );
  }
  return pages.flat().filter((issue) => !issue?.pull_request);
}

function closeGitHubIssue({ repository, number, comment }) {
  runGh([
    "issue",
    "close",
    String(number),
    "--repo",
    repository,
    "--reason",
    "completed",
    "--comment",
    comment,
  ]);
}

export function runGh(args, { spawn = spawnSync } = {}) {
  const maxBuffer = 64 * 1024 * 1024;
  const result = spawn("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
  });
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      throw new Error(
        `gh ${args[0]} output exceeded ${maxBuffer / (1024 * 1024)} MiB buffer`,
      );
    }
    throw new Error(`Could not run gh: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    const outcome =
      result.status === null
        ? `signal ${result.signal ?? "unknown"}`
        : `exit ${result.status}`;
    throw new Error(
      `gh ${args[0]} failed with ${outcome}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

function requireEnvironmentValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertCompleteSemver(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a complete SemVer`);
  }
  const match = completeSemverPattern.exec(value);
  const invalidNumericPrerelease = match?.[4]
    ?.split(".")
    .some(
      (identifier) =>
        /^\d+$/.test(identifier) &&
        identifier.length > 1 &&
        identifier.startsWith("0"),
    );
  if (!match || invalidNumericPrerelease) {
    throw new Error(`${label} must be a complete SemVer`);
  }
}

function readJson(path, label) {
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read: ${errorMessage(error)}`);
  }
  return parseJson(content, label);
}

function parseJson(content, label) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
}

function formatIssueLabel(number) {
  return Number.isSafeInteger(number) && number > 0
    ? `Promotion reminder issue #${number}`
    : "Promotion reminder issue";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
