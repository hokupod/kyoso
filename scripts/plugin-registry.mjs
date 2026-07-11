// Query the npm registry over HTTPS directly instead of spawning the npm CLI:
// interposing shims (safe-chain in CI) both pollute npm's stdout and apply a
// minimum-package-age policy that hides freshly published versions, which
// would fail promotion right after a release. This is a read-only existence
// check for our own OIDC-provenance-published package, so bypassing the shim
// does not weaken any install-time protection.
export async function assertPublishedCliVersion({
  packageName,
  packageVersion,
}) {
  const requested = `${packageName}@${packageVersion}`;
  const url = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
  let payload;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `npm registry lookup for ${requested} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const published = payload?.versions?.[packageVersion]?.version;
  if (published !== packageVersion) {
    throw new Error(
      `npm registry does not list ${requested}; expected version ${packageVersion} to be published`,
    );
  }

  return requested;
}
