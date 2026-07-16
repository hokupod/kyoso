import { KYOSO_VERSION } from "../core/constants.js";

export const CURRENT_SKILL_DIGEST =
  "sha256:8654e68ea61f2acea29027056802bf627ad737f084c9a86ab052946943538409";

export const KNOWN_SKILL_DIGESTS_BY_VERSION = {
  "0.11.0": [
    {
      digest:
        "sha256:110dd872a3d1c8a71474a0eadb226f51a6addd86f9d4f3ed17b73678b3179a4e",
      kind: "historical",
    },
    {
      digest:
        "sha256:570f83f716734f34db00147f1b98bc8cd4e9c0016d3946b352ecef4a5d6b8734",
      kind: "historical",
    },
  ],
  "0.8.0": [
    {
      digest:
        "sha256:b16ea3f8141a01399b96dee650365d99df2b8c5fc99184d9cb22d5d72c106fd8",
      kind: "historical",
    },
  ],
} as const;

export function knownSkillDigest(
  digest: string,
): { version: string; kind: "current" | "historical" } | undefined {
  if (digest === CURRENT_SKILL_DIGEST) {
    return { version: KYOSO_VERSION, kind: "current" };
  }
  for (const [version, entries] of Object.entries(
    KNOWN_SKILL_DIGESTS_BY_VERSION,
  )) {
    const entry = entries.find((candidate) => candidate.digest === digest);
    if (entry) return { version, kind: entry.kind };
  }
  return undefined;
}
