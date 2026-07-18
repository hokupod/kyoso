import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// @ts-expect-error The migrator is intentionally shipped as a standalone Node.js script.
import { migratePluginRuntimeContract } from "../../scripts/plugin-runtime-contract-migrate.mjs";

const bundledContract = {
  schemaVersion: 2,
  minimumSupportedCodexVersion: "0.144.0-alpha.4",
  expectedContract: {
    distribution: {
      pluginVersion: "0.7.2",
      mcpCommand: "npx",
      mcpPackagePin: "@kyo-so/cli@0.13.1",
      mcpExecutable: "kyoso",
    },
  },
};

const versions = ["0.144.0-alpha.4", "0.144.1"];

describe("plugin runtime contract migration", () => {
  test("re-probes every recorded version and atomically replaces only after validation", async () => {
    const recordPath = await writeSourceRecord();

    const result = await migratePluginRuntimeContract(
      { recordPath, write: true },
      {
        readBundledContract: () => bundledContract,
        runProbe: recordSuccessfulProbe,
      },
    );

    const record = await readJson(recordPath);
    expect(result).toMatchObject({
      action: "updated",
      schemaVersion: 2,
      versions,
    });
    expect(record).toEqual({
      schemaVersion: 2,
      minimumSupportedCodexVersion: "0.144.0-alpha.4",
      expectedContract: bundledContract.expectedContract,
      probes: versions.map(probeRow),
    });
    expect(await migrationTemps(recordPath)).toEqual([]);
  });

  test("runs a complete dry-run without replacing the record", async () => {
    const recordPath = await writeSourceRecord();
    const before = await readFile(recordPath, "utf8");

    const result = await migratePluginRuntimeContract(
      { recordPath },
      {
        readBundledContract: () => bundledContract,
        runProbe: recordSuccessfulProbe,
      },
    );

    expect(result).toMatchObject({ action: "dry-run", versions });
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(await migrationTemps(recordPath)).toEqual([]);
  });

  test("rejects a bundled minimum version that differs from the record before probing", async () => {
    const recordPath = await writeSourceRecord();
    const before = await readFile(recordPath, "utf8");
    let probes = 0;

    await expect(
      migratePluginRuntimeContract(
        { recordPath, write: true },
        {
          readBundledContract: () => ({
            ...bundledContract,
            minimumSupportedCodexVersion: "0.144.1",
          }),
          runProbe: async () => {
            probes += 1;
          },
        },
      ),
    ).rejects.toThrow("does not match the compatibility record");

    expect(probes).toBe(0);
    expect(await readFile(recordPath, "utf8")).toBe(before);
    expect(await migrationTemps(recordPath)).toEqual([]);
  });

  test.each([
    {
      name: "a probe failure",
      runProbe: async ({ version }: { version: string }) => {
        throw new Error(`probe failed for ${version}`);
      },
      expected: "probe failed",
    },
    {
      name: "duplicate candidate versions",
      runProbe: async ({ version, recordPath }: ProbeOptions) => {
        const record = await readJson(recordPath);
        record.probes.push(probeRow(version), probeRow(version));
        await writeJson(recordPath, record);
      },
      expected: "duplicate Codex versions",
    },
    {
      name: "a missing candidate version",
      runProbe: async ({ version, recordPath }: ProbeOptions) => {
        if (version === versions[0]) return;
        const record = await readJson(recordPath);
        record.probes.push(probeRow(version));
        await writeJson(recordPath, record);
      },
      expected: "version set does not match",
    },
    {
      name: "a candidate schema mismatch",
      runProbe: async ({ version, recordPath }: ProbeOptions) => {
        const record = await readJson(recordPath);
        record.schemaVersion = 1;
        record.probes.push(probeRow(version));
        await writeJson(recordPath, record);
      },
      expected: "schemaVersion does not match",
    },
  ])(
    "leaves the record unchanged after $name",
    async ({ runProbe, expected }) => {
      const recordPath = await writeSourceRecord();
      const before = await readFile(recordPath, "utf8");

      await expect(
        migratePluginRuntimeContract(
          { recordPath, write: true },
          { readBundledContract: () => bundledContract, runProbe },
        ),
      ).rejects.toThrow(expected);

      expect(await readFile(recordPath, "utf8")).toBe(before);
      expect(await migrationTemps(recordPath)).toEqual([]);
    },
  );

  test("does not overwrite a concurrently changed record", async () => {
    const recordPath = await writeSourceRecord();
    const concurrent = `${JSON.stringify({ concurrent: true })}\n`;

    await expect(
      migratePluginRuntimeContract(
        { recordPath, write: true },
        {
          readBundledContract: () => bundledContract,
          runProbe: recordSuccessfulProbe,
          afterProbes: async () => {
            await writeFile(recordPath, concurrent, "utf8");
          },
        },
      ),
    ).rejects.toThrow("changed during migration");

    expect(await readFile(recordPath, "utf8")).toBe(concurrent);
    expect(await migrationTemps(recordPath)).toEqual([]);
  });
});

type ProbeOptions = { version: string; recordPath: string };

async function recordSuccessfulProbe({ version, recordPath }: ProbeOptions) {
  const record = await readJson(recordPath);
  record.probes.push(probeRow(version));
  await writeJson(recordPath, record);
}

function probeRow(codexVersion: string) {
  return {
    codexVersion,
    verifiedAt: "2026-07-18",
    os: { platform: "darwin", release: "25.5.0", arch: "arm64" },
    fixtureSchemaVersion: 2,
  };
}

async function writeSourceRecord(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kyoso-runtime-migrate-"));
  const recordPath = join(directory, "codex-plugin-runtime.json");
  await writeJson(recordPath, {
    schemaVersion: 1,
    minimumSupportedCodexVersion: "0.144.0-alpha.4",
    expectedContract: { legacy: true },
    probes: versions.map((codexVersion) => ({
      ...probeRow(codexVersion),
      fixtureSchemaVersion: 1,
    })),
  });
  return recordPath;
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function migrationTemps(recordPath: string): Promise<string[]> {
  return (await readdir(dirname(recordPath))).filter((entry) =>
    entry.includes(".kyoso-runtime-"),
  );
}
