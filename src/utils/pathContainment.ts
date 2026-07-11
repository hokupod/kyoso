import { resolve, sep } from "node:path";

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
