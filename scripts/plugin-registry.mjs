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
  // Query the version-specific document (verified to return 200 for published
  // versions and 404 for missing ones on scoped packages) instead of the full
  // packument, which grows with every release.
  const url = `https://registry.npmjs.org/${packageName.replace("/", "%2F")}/${packageVersion}`;
  let payload;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) {
      throw new Error(`version ${packageVersion} is not published`);
    }
    if (!response.ok) {
      throw new Error(`registry returned HTTP ${response.status}`);
    }
    payload = await response.json();
  } catch (error) {
    throw new Error(
      `npm registry lookup for ${requested} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validatePublishedCliMetadata(payload, { packageName, packageVersion });
}

export function validatePublishedCliMetadata(
  payload,
  { packageName, packageVersion },
) {
  const requested = `${packageName}@${packageVersion}`;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`npm registry metadata for ${requested} must be an object`);
  }
  if (payload.name !== packageName) {
    throw new Error(
      `npm registry metadata name ${String(payload.name)} does not match ${packageName}`,
    );
  }
  if (payload.version !== packageVersion) {
    throw new Error(
      `npm registry does not list ${requested}; expected version ${packageVersion} to be published`,
    );
  }
  if (
    !payload.bin ||
    typeof payload.bin !== "object" ||
    Array.isArray(payload.bin)
  ) {
    throw new Error(
      `npm registry metadata for ${requested} must include a bin map`,
    );
  }
  if (payload.bin.kyoso !== "dist/bin/kyoso.js") {
    throw new Error(
      `npm registry metadata for ${requested} must expose bin.kyoso as dist/bin/kyoso.js`,
    );
  }
  return requested;
}
