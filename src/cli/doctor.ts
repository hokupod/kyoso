import { accessSync } from "node:fs";
import { delimiter } from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { resolveJudgeProvider } from "../judge/provider.js";

export async function runDoctor(options: {
  cwd: string;
  configPath?: string;
  ignoreConfig?: boolean;
  trustConfig?: boolean;
  promptForTrust?: boolean;
  trustStorePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const env = options.env ?? process.env;
  const loaded = await loadConfig(options);
  const lines: string[] = ["Kyoso doctor", "", "Runtime"];
  lines.push(
    `  Bun: ${commandExists("bun", env) ? "ok" : "warning not found"}`,
  );
  lines.push(
    `  Node/npm: ${commandExists("npm", env) ? "ok" : "warning npm not found"}`,
  );

  lines.push("", "Config");
  lines.push(
    `  kyoso.config.ts: ${loaded.configPath ? `found ${loaded.configPath}` : "not found; using defaults"}`,
  );
  lines.push(
    `  trusted config: ${formatTrustStatus(loaded.configTrustStatus)}`,
  );
  if (loaded.configHash) lines.push(`  config hash: ${loaded.configHash}`);
  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);

  lines.push("", "MCP", "  stdio server: ok");

  lines.push("", "ACP agents");
  for (const agent of ["codex", "claude"] as const) {
    const config = loaded.config.agents[agent];
    const exists = commandExists(config.command, env);
    lines.push(
      `  ${agent === "codex" ? "Codex" : "Claude"}: ${exists ? "ok" : "warning command not found"}`,
    );
    lines.push(`    command: ${[config.command, ...config.args].join(" ")}`);
    if (!exists && config.command === "npx" && commandExists("bunx", env)) {
      lines.push(
        '    hint: replace command "npx" with "bunx" in kyoso.config.ts',
      );
    }
    if (agent === "claude") {
      const hasApiKey = hasEnv(env, "ANTHROPIC_API_KEY");
      const hasOAuthToken = hasEnv(env, "CLAUDE_CODE_OAUTH_TOKEN");
      if (!hasApiKey && !hasOAuthToken) {
        lines.push(
          "    auth: set ANTHROPIC_API_KEY (API billing) or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN (subscription)",
        );
      } else if (hasApiKey && hasOAuthToken) {
        lines.push("    auth: detected");
        lines.push(formatClaudeDualAuthWarning(config.auth.preferApiKey));
      } else if (hasOAuthToken) {
        lines.push("    auth: detected Claude Code OAuth token");
      } else {
        lines.push("    auth: detected Anthropic API key");
      }
    } else {
      lines.push("    auth: detected or delegated");
    }
  }

  const judgeProvider =
    loaded.config.judge.mode === "deterministic_only"
      ? "deterministic_fallback"
      : resolveJudgeProvider(loaded.config.judge.provider, env);
  lines.push("", "Judge");
  lines.push(`  provider: ${judgeProvider}`);
  lines.push(
    judgeProvider === "deterministic_fallback"
      ? "  billing: none (deterministic fallback)"
      : "  billing: direct provider API calls (pay-per-token billing)",
  );

  lines.push("", "Security");
  lines.push("  secret scan: enabled");
  lines.push(
    `  blockOnDetectedSecret: ${loaded.config.secrets.blockOnDetectedSecret}`,
  );
  lines.push(`  network default: ${loaded.config.network.defaultMode}`);

  lines.push("", "Audit");
  lines.push(`  directory: ${loaded.config.audit.directory}`);
  lines.push(
    `  raw agent output: ${loaded.config.audit.includeRawAgentOutput ? "enabled" : "disabled"}`,
  );

  return lines.join("\n");
}

function formatTrustStatus(status: string): string {
  if (status === "trusted_by_flag") return "trusted by --trust-config";
  if (status === "trusted_interactively") return "trusted interactively";
  if (status === "untrusted_skipped") return "untrusted; skipped";
  if (status === "not_found") return "not found";
  return status;
}

function formatClaudeDualAuthWarning(preferApiKey: boolean): string {
  if (preferApiKey) {
    return "    auth policy: Kyoso forwards only ANTHROPIC_API_KEY because agents.claude.auth.preferApiKey is true";
  }
  return "    auth policy: Kyoso forwards only CLAUDE_CODE_OAUTH_TOKEN; set agents.claude.auth.preferApiKey to true to use ANTHROPIC_API_KEY";
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return typeof env[key] === "string" && env[key]!.trim().length > 0;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  const paths = env.PATH?.split(delimiter) ?? [];
  return paths.some((path) => {
    try {
      accessSync(`${path}/${command}`);
      return true;
    } catch {
      return false;
    }
  });
}
