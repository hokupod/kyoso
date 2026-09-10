import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

test("updates the reviewed checkout pin with workflows while rejecting unsynchronized pins", async () => {
  const config = JSON.parse(await readFile("renovate.json", "utf8"));
  const manager = config.customManagers.find(
    (entry: { description: string }) =>
      entry.description ===
      "Reviewed checkout pin used by the privileged promotion verifier",
  );
  const source = await readFile("scripts/plugin-distribution.mjs", "utf8");
  const pattern = new RegExp(manager.matchStrings[0], "g");
  const matches = [...source.matchAll(pattern)];
  expect(matches).toHaveLength(1);
  const { depName, currentDigest, currentValue } = matches[0]!.groups!;
  expect(depName).toBe("actions/checkout");
  expect(currentValue).toMatch(/^v\d/);
  expect(config.packageRules).toContainEqual(
    expect.objectContaining({
      matchPackageNames: [depName],
      groupName: depName,
    }),
  );

  const fixture = await mkdtemp(join(tmpdir(), "kyoso-checkout-sync-"));
  try {
    for (const path of [
      ".agents/skills",
      ".agents/plugins",
      ".claude-plugin",
      "plugins",
      "docs/compatibility",
      "src/cli/knownSkillDigests.ts",
      "src/cli/pluginRuntimeContract.ts",
      "package.json",
      ".github/workflows/plugin-promotion.yml",
    ]) {
      await mkdir(dirname(join(fixture, path)), { recursive: true });
      await cp(path, join(fixture, path), { recursive: true });
    }
    const nextDigest = "a".repeat(40);
    expect(nextDigest).not.toBe(currentDigest);
    const workflowPath = join(
      fixture,
      ".github/workflows/plugin-promotion.yml",
    );
    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain(`${depName}@${currentDigest}`);
    await writeFile(
      workflowPath,
      workflow.replaceAll(
        `${depName}@${currentDigest}`,
        `${depName}@${nextDigest}`,
      ),
    );
    const scriptPath = join(fixture, "scripts/plugin-distribution.mjs");
    await mkdir(dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, source);
    const stale = await import(pathToFileURL(scriptPath).href);
    const options = {
      root: fixture,
      verifyPackageArchive: false,
      verifyPromotionWorkflow: true,
    };
    expect(() => stale.verifyPluginDistribution(options)).toThrow(
      "close job steps must be checkout, Node 24 setup, and reconciliation only",
    );
    const updatedPath = join(fixture, "scripts/updated.mjs");
    await writeFile(
      updatedPath,
      source.replace(pattern, (match) =>
        match.replace(currentDigest!, nextDigest),
      ),
    );
    const updated = await import(pathToFileURL(updatedPath).href);
    expect(() => updated.verifyPluginDistribution(options)).not.toThrow();
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
