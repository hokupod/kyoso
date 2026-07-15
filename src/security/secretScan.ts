import type { KyosoReviewRequest, SecretScanResult } from "../core/types.js";
import { REDACTION } from "./redact.js";

type SecretPattern = {
  kind: string;
  pattern: RegExp;
};

const SECRET_PATTERNS: SecretPattern[] = [
  { kind: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
  },
  { kind: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "google_private_key",
    pattern: /"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----[^"]+"/g,
  },
  {
    kind: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  {
    kind: "stripe_secret_key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  },
  {
    kind: "high_entropy_assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{32,}["']?/gi,
  },
];

export function scanAndRedactSecrets(
  request: KyosoReviewRequest,
): SecretScanResult {
  const cloned = structuredClone(request);
  const matches: SecretScanResult["matches"] = [];
  let redactions = 0;

  const redactText = (value: string, location: string): string => {
    let next = value;
    for (const { kind, pattern } of SECRET_PATTERNS) {
      next = next.replace(pattern, () => {
        redactions += 1;
        matches.push({ kind, location });
        return REDACTION;
      });
    }
    return next;
  };

  cloned.goal = redactText(cloned.goal, "goal");
  if (cloned.reviewContract?.nonGoals) {
    cloned.reviewContract.nonGoals = cloned.reviewContract.nonGoals.map(
      (nonGoal, index) =>
        redactText(nonGoal, `reviewContract.nonGoals[${index}]`),
    );
  }
  if (cloned.reviewContract?.acceptedRisks) {
    cloned.reviewContract.acceptedRisks =
      cloned.reviewContract.acceptedRisks.map((risk, index) => ({
        ...risk,
        rationale: redactText(
          risk.rationale,
          `reviewContract.acceptedRisks[${index}].rationale`,
        ),
      }));
  }
  if (cloned.repoSummary)
    cloned.repoSummary = redactText(cloned.repoSummary, "repoSummary");
  if (cloned.currentPlan)
    cloned.currentPlan = redactText(cloned.currentPlan, "currentPlan");
  if (cloned.constraints) {
    cloned.constraints = cloned.constraints.map((constraint, index) =>
      redactText(constraint, `constraints[${index}]`),
    );
  }
  if (cloned.diff)
    cloned.diff.unifiedDiff = redactText(
      cloned.diff.unifiedDiff,
      "diff.unifiedDiff",
    );
  if (cloned.selectedFiles) {
    cloned.selectedFiles = cloned.selectedFiles.map((file, index) => {
      const path = redactText(file.path, `selectedFiles[${index}].path`);
      const pathSecret = isCredentialPath(path);
      if (pathSecret) {
        redactions += 1;
        matches.push({
          kind: ".env_or_credential_path",
          location: `selectedFiles:${path}`,
        });
      }
      return {
        ...file,
        path,
        content: pathSecret
          ? REDACTION
          : redactText(file.content, `selectedFiles:${path}`),
      };
    });
  }

  return {
    detected: redactions > 0,
    redactions,
    matches,
    redactedRequest: cloned,
  };
}

function isCredentialPath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  return segments.some(
    (segment) =>
      segment === ".env" ||
      segment.startsWith(".env.") ||
      segment === ".ssh" ||
      segment === ".aws" ||
      segment === ".gcp" ||
      segment === ".azure",
  );
}
