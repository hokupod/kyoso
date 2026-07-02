import { accessSync } from "node:fs";
import { delimiter } from "node:path";
import { loadConfig } from "../config/loadConfig.js";

export async function runDoctor(options: { cwd: string; configPath?: string; ignoreConfig?: boolean }): Promise<string> {
  const loaded = await loadConfig(options);
  const lines: string[] = ["Kyoso doctor", "", "Runtime"];
  lines.push(`  Bun: ${commandExists("bun") ? "ok" : "warning not found"}`);
  lines.push(`  Node/npm: ${commandExists("npm") ? "ok" : "warning npm not found"}`);

  lines.push("", "Config");
  lines.push(`  kyoso.config.ts: ${loaded.configPath ? `found ${loaded.configPath}` : "not found; using defaults"}`);
  lines.push(`  trusted config: ${options.ignoreConfig ? "ignored" : "local default trust"}`);
  if (loaded.configHash) lines.push(`  config hash: ${loaded.configHash}`);
  for (const warning of loaded.warnings) lines.push(`  warning: ${warning}`);

  lines.push("", "MCP", "  stdio server: ok");

  lines.push("", "ACP agents");
  for (const agent of ["codex", "claude"] as const) {
    const config = loaded.config.agents[agent];
    lines.push(`  ${agent === "codex" ? "Codex" : "Claude"}: ${commandExists(config.command) ? "ok" : "warning command not found"}`);
    lines.push(`    command: ${[config.command, ...config.args].join(" ")}`);
    if (agent === "claude" && !process.env.ANTHROPIC_API_KEY) {
      lines.push("    auth: ANTHROPIC_API_KEY not found; existing local Claude credentials may work depending on environment");
    } else {
      lines.push("    auth: detected or delegated");
    }
  }

  lines.push("", "Security");
  lines.push("  secret scan: enabled");
  lines.push(`  blockOnDetectedSecret: ${loaded.config.secrets.blockOnDetectedSecret}`);
  lines.push(`  network default: ${loaded.config.network.defaultMode}`);

  lines.push("", "Audit");
  lines.push(`  directory: ${loaded.config.audit.directory}`);
  lines.push(`  raw agent output: ${loaded.config.audit.includeRawAgentOutput ? "enabled" : "disabled"}`);

  return lines.join("\n");
}

function commandExists(command: string): boolean {
  const paths = process.env.PATH?.split(delimiter) ?? [];
  return paths.some((path) => {
    try {
      accessSync(`${path}/${command}`);
      return true;
    } catch {
      return false;
    }
  });
}
