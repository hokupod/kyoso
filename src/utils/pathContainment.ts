import { resolve, sep } from "node:path";

// Security containment primitive: comparison is deliberately case-sensitive.
// Case-folding (e.g. toLowerCase) would conflate genuinely distinct paths on
// case-sensitive volumes (APFS/NTFS support both modes) and weaken the
// boundary toward fail-open; a casing mismatch here fails closed instead.
// Callers resolve both sides via realpath, so casing is consistent in
// practice. Full case-insensitive support belongs to identity checks
// (realpath + dev/ino), as done in the FileHandle layer.
export function isPathWithin(candidate: string, root: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedRoot = resolve(root);
  const boundary = resolvedRoot.endsWith(sep)
    ? resolvedRoot
    : `${resolvedRoot}${sep}`;
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(boundary)
  );
}
