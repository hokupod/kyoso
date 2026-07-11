import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createTraceWriter } from "../../src/audit/trace.js";
import { isPathWithin } from "../../src/utils/pathContainment.js";
import { auditTracePath } from "../helpers/auditState.js";

const date = new Date().toISOString().slice(0, 10);

describe("audit trace writer", () => {
  test("uses a path-segment boundary for containment", () => {
    const root = join(tmpdir(), "kyoso-root");
    expect(isPathWithin(join(root, "child"), root)).toBe(true);
    expect(isPathWithin(`${root}-other`, root)).toBe(false);
  });

  test("writes only below a trusted state root when workspace trace paths are symlinks", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const canary = join(await workspaceFixture(), "canary.jsonl");
    await writeFile(canary, "canary\n", "utf8");
    const workspaceTrace = join(cwd, ".kyoso", "traces", date, "trace.jsonl");
    await mkdir(join(cwd, ".kyoso", "traces", date), { recursive: true });
    await symlink(canary, workspaceTrace);

    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });
    await trace.write({ type: "first" });
    await trace.finalize();

    expect(await readFile(canary, "utf8")).toBe("canary\n");
    const expected = await auditTracePath({
      stateHome,
      cwd,
      directory: ".kyoso/traces",
      date,
      traceId: "trace",
    });
    expect(trace.tracePath).toBe(expected);
    expect((await lstat(expected)).isFile()).toBe(true);
    expect(trace.tracePath).not.toContain(cwd);
    expect(trace.warnings).toEqual([]);
  });

  test("uses the real workspace path for a stable hash and falls back to HOME state", async () => {
    const home = await stateHomeFixture();
    const workspace = await workspaceFixture();
    const workspaceLink = join(await workspaceFixture(), "workspace-link");
    await symlink(workspace, workspaceLink);
    const stateHome = join(home, ".local", "state");
    const trace = createTraceWriter({
      enabled: true,
      directory: "events",
      traceId: "trace",
      cwd: workspaceLink,
      env: { HOME: home },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBe(
      await auditTracePath({
        stateHome,
        cwd: workspace,
        directory: "events",
        date,
        traceId: "trace",
      }),
    );
  });

  test("falls back to the default logical directory without exposing an unsafe value", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const trace = createTraceWriter({
      enabled: true,
      directory: "safe/../outside",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.warnings).toContain(
      "AUDIT_DIRECTORY_IGNORED: Audit directory is invalid; using the default logical directory.",
    );
    expect(trace.warnings.join("\n")).not.toContain("safe/../outside");
    expect(trace.tracePath).toBe(
      await auditTracePath({
        stateHome,
        cwd,
        directory: ".kyoso/traces",
        date,
        traceId: "trace",
      }),
    );
  });

  test("fails closed when the state root is inside the workspace", async () => {
    const cwd = await workspaceFixture();
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: join(cwd, "state") },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.",
    );
    await expect(lstat(join(cwd, ".kyoso", "traces"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails closed when XDG_STATE_HOME reaches an external target through a workspace symlink", async () => {
    const cwd = await workspaceFixture();
    const stateHome = await stateHomeFixture();
    const workspaceLink = join(cwd, "state-link");
    await symlink(stateHome, workspaceLink);
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: workspaceLink },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.",
    );
    await expect(lstat(join(stateHome, "kyoso"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects a symlinked Kyoso managed root without touching its target", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const canaryRoot = await workspaceFixture();
    await symlink(canaryRoot, join(stateHome, "kyoso"));
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.",
    );
    await expect(lstat(join(canaryRoot, "workspaces"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not open a canary after a final-path race", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const canary = join(await workspaceFixture(), "canary.jsonl");
    await writeFile(canary, "canary\n", "utf8");
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
      async beforeOpen(tracePath) {
        await symlink(canary, tracePath);
      },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(await readFile(canary, "utf8")).toBe("canary\n");
    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_WRITE_FAILED: Audit trace writing failed; no further audit events will be written.",
    );
    expect(
      trace.warnings.filter((warning) =>
        warning.startsWith("AUDIT_WRITE_FAILED"),
      ),
    ).toHaveLength(1);
  });

  test("rejects an existing final path without replacing it", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const existing = await auditTracePath({
      stateHome,
      cwd,
      directory: ".kyoso/traces",
      date,
      traceId: "trace",
    });
    await mkdir(dirname(existing), { recursive: true });
    await writeFile(existing, "existing\n", "utf8");
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(await readFile(existing, "utf8")).toBe("existing\n");
    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_WRITE_FAILED: Audit trace writing failed; no further audit events will be written.",
    );
  });

  test("serializes concurrent writes and closes after the queued events", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const trace = createTraceWriter({
      enabled: true,
      directory: "events",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
      async writeChunk(handle, buffer, offset) {
        const { bytesWritten } = await handle.write(
          buffer,
          offset,
          Math.min(1, buffer.byteLength - offset),
          null,
        );
        return bytesWritten;
      },
    });

    await Promise.all([
      trace.write({ type: "first" }),
      trace.write({ type: "second" }),
      trace.write({ type: "third" }),
    ]);
    await trace.finalize();

    const text = await readFile(trace.tracePath ?? "", "utf8");
    expect(
      text
        .trimEnd()
        .split("\n")
        .map((line) => (JSON.parse(line) as { type: string }).type),
    ).toEqual(["first", "second", "third"]);
    expect(trace.warnings).toEqual([]);
  });

  test("fails closed when platform or secure-open capabilities are unavailable", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const unavailable = [
      { platform: "win32" as const },
      { getuid: () => undefined },
      { openConstants: {} },
    ];

    for (const options of unavailable) {
      const trace = createTraceWriter({
        enabled: true,
        directory: ".kyoso/traces",
        traceId: `trace-${unavailable.indexOf(options)}`,
        cwd,
        env: { XDG_STATE_HOME: stateHome },
        ...options,
      });
      await trace.write({ type: "first" });
      await trace.finalize();
      expect(trace.tracePath).toBeUndefined();
      expect(trace.warnings.join("\n")).toContain("AUDIT_DISABLED_");
    }

    await expect(lstat(join(cwd, ".kyoso", "traces"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("fails closed for a group- or world-writable state root", async () => {
    if (process.platform === "win32") return;
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    await chmod(stateHome, 0o777);
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.",
    );
  });

  test("fails closed when a non-sticky parent can replace the state root", async () => {
    if (process.platform === "win32") return;
    const stateParent = await stateHomeFixture();
    const stateHome = join(stateParent, "state");
    await mkdir(stateHome, { mode: 0o700 });
    await chmod(stateParent, 0o777);
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd: await workspaceFixture(),
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    expect(trace.warnings).toContain(
      "AUDIT_DISABLED_UNSAFE_STATE_ROOT: Audit state root could not be verified.",
    );
  });

  test("does not create a missing state root below a replaceable ancestor", async () => {
    if (process.platform === "win32") return;
    const replaceableParent = await stateHomeFixture();
    const trustedLookingAncestor = join(replaceableParent, "ancestor");
    await mkdir(trustedLookingAncestor, { mode: 0o700 });
    await chmod(replaceableParent, 0o777);
    const stateHome = join(trustedLookingAncestor, "missing-state");
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd: await workspaceFixture(),
      env: { XDG_STATE_HOME: stateHome },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.tracePath).toBeUndefined();
    await expect(lstat(stateHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports a close failure without throwing from write or finalize", async () => {
    const stateHome = await stateHomeFixture();
    const cwd = await workspaceFixture();
    const trace = createTraceWriter({
      enabled: true,
      directory: ".kyoso/traces",
      traceId: "trace",
      cwd,
      env: { XDG_STATE_HOME: stateHome },
      async closeHandle(handle) {
        await handle.close();
        throw new Error("simulated close failure");
      },
    });

    await trace.write({ type: "first" });
    await trace.finalize();

    expect(trace.warnings).toContain(
      "AUDIT_FINALIZE_FAILED: Audit trace close failed.",
    );
    await trace.write({ type: "after-finalize" });
    expect(trace.warnings).toContain(
      "AUDIT_WRITE_AFTER_FINALIZE: Audit trace is already finalized.",
    );
  });
});

async function stateHomeFixture(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "kyoso-audit-state-"));
}

async function workspaceFixture(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "kyoso-audit-workspace-"));
}
