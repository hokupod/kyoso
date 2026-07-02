import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listKyosoMcpTools } from "../../src/mcp/server.js";
import { runDoctor } from "../../src/cli/doctor.js";

describe("e2e surfaces", () => {
  test("MCP registers stable tool names", () => {
    expect(listKyosoMcpTools()).toEqual(["plan_review", "security_review", "diff_review"]);
  });

  test("doctor works without credentials", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-doctor-"));
    const output = await runDoctor({ cwd, ignoreConfig: true });
    expect(output).toContain("Kyoso doctor");
    expect(output).toContain("ACP agents");
    expect(output).toContain("raw agent output: disabled");
  });

  test("CLI preserves network default from config when --network is omitted", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "kyoso-cli-"));
    const configPath = join(cwd, "kyoso.config.ts");
    await writeFile(
      configPath,
      `import { defineConfig } from "@kyoso/cli";
export default defineConfig({
  network: { defaultMode: "unrestricted" },
});
`,
      "utf8",
    );

    const proc = Bun.spawn(
      [
        "bun",
        "run",
        join(process.cwd(), "src/cli/main.ts"),
        "plan",
        "--goal",
        "review",
        "--repo-summary",
        "repo",
        "--config",
        configPath,
        "--json",
      ],
      {
        cwd,
        env: { ...process.env, KYOSO_TEST_FAKE_AGENTS: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).audit.networkMode).toBe("unrestricted");
  });
});
