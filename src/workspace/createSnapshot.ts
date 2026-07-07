import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildAgentPrompt } from "../acp/prompts.js";
import type {
  AgentName,
  AgentRole,
  KyosoReviewRequest,
  ReviewTool,
} from "../core/types.js";
import {
  isAllowedPath,
  isDeniedPath,
  normalizeRelativePath,
} from "../context/pathPolicy.js";

export type Snapshot = {
  root: string;
  repoDir: string;
  contextDir: string;
  fileCount: number;
};

export async function createSnapshot(
  traceId: string,
  tool: ReviewTool,
  request: KyosoReviewRequest,
  options: {
    denyPatterns?: string[];
    allowPatterns?: string[];
    agentRoles?: Partial<Record<AgentName, AgentRole>>;
  } = {},
): Promise<Snapshot> {
  const root = await mkdtemp(join(tmpdir(), `kyoso-${traceId}-`));
  const repoDir = join(root, "repo");
  const contextDir = join(root, "context");
  await mkdir(repoDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });

  let fileCount = 0;
  for (const file of request.selectedFiles ?? []) {
    const relative = normalizeRelativePath(file.path);
    if (isDeniedPath(relative, options.denyPatterns ?? [])) continue;
    if (!isAllowedPath(relative, options.allowPatterns ?? [])) continue;
    const dest = join(repoDir, relative);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content, "utf8");
    await chmod(dest, 0o444).catch(() => undefined);
    fileCount += 1;
  }

  await writeFile(
    join(contextDir, "request.json"),
    JSON.stringify(stripContents(request), null, 2),
    "utf8",
  );
  await writeFile(
    join(contextDir, "selected_files_manifest.json"),
    JSON.stringify(buildSelectedFilesManifest(request), null, 2),
    "utf8",
  );
  await writeFile(
    join(contextDir, "instructions.codex.md"),
    buildAgentPrompt(
      tool,
      request,
      "codex",
      options.agentRoles?.codex ?? "implementation_reviewer",
    ),
    "utf8",
  );
  await writeFile(
    join(contextDir, "instructions.claude.md"),
    buildAgentPrompt(
      tool,
      request,
      "claude",
      options.agentRoles?.claude ?? "architecture_security_reviewer",
    ),
    "utf8",
  );
  if (request.repoSummary)
    await writeFile(
      join(contextDir, "repo_summary.md"),
      request.repoSummary,
      "utf8",
    );
  if (request.currentPlan)
    await writeFile(
      join(contextDir, "current_plan.md"),
      request.currentPlan,
      "utf8",
    );
  if (request.diff?.unifiedDiff)
    await writeFile(
      join(contextDir, "diff.patch"),
      request.diff.unifiedDiff,
      "utf8",
    );

  return { root, repoDir, contextDir, fileCount };
}

function stripContents(request: KyosoReviewRequest): KyosoReviewRequest {
  return {
    ...request,
    selectedFiles: request.selectedFiles?.map((file) => ({
      ...file,
      content: `[${new TextEncoder().encode(file.content).byteLength} bytes omitted from request manifest]`,
    })),
  };
}

function buildSelectedFilesManifest(request: KyosoReviewRequest): Array<{
  path: string;
  language?: string;
  truncated?: boolean;
  byteCount: number;
}> {
  return (request.selectedFiles ?? []).map((file) => ({
    path: file.path,
    language: file.language,
    truncated: file.truncated,
    byteCount: new TextEncoder().encode(file.content).byteLength,
  }));
}
