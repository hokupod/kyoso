import { normalize, sep } from "node:path";
import { KyosoRequestError } from "../core/errors.js";

export function normalizeRelativePath(path: string): string {
  const normalized = normalize(path).replaceAll("\\", "/");
  if (
    normalized === "." ||
    normalized.startsWith("..") ||
    normalized.includes(`${sep}..${sep}`) ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new KyosoRequestError(`Path escapes workspace root: ${path}`, "INVALID_PATH");
  }
  return normalized;
}

export function isDeniedPath(path: string, denyPatterns: string[]): boolean {
  return matchesPathPattern(path, denyPatterns, "deny");
}

export function isAllowedPath(path: string, allowPatterns: string[]): boolean {
  if (allowPatterns.length === 0) return true;
  return matchesPathPattern(path, allowPatterns, "allow");
}

function matchesPathPattern(path: string, patterns: string[], mode: "allow" | "deny"): boolean {
  const normalized = normalizeRelativePath(path);
  const segments = normalized.split("/");
  return patterns.some((pattern) => {
    const normalizedPattern = normalizeRelativePath(pattern);
    if (normalizedPattern.endsWith(".*") && !normalizedPattern.includes("/")) {
      const base = normalizedPattern.slice(0, -2);
      if (mode === "allow") {
        const firstSegment = segments[0] ?? "";
        return firstSegment === base || firstSegment.startsWith(`${base}.`);
      }
      return segments.some((segment) => segment === base || segment.startsWith(`${base}.`));
    }
    if (normalizedPattern.includes("*")) {
      const escaped = normalizedPattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
      const regex = mode === "allow" ? new RegExp(`^${escaped}($|/)`) : new RegExp(`(^|/)${escaped}($|/)`);
      return regex.test(normalized);
    }
    if (!normalizedPattern.includes("/")) {
      if (mode === "allow") {
        return normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`);
      }
      return segments.includes(normalizedPattern);
    }
    if (mode === "allow") {
      return normalized === normalizedPattern || normalized.startsWith(`${normalizedPattern}/`);
    }
    return (
      normalized === normalizedPattern ||
      normalized.startsWith(`${normalizedPattern}/`) ||
      normalized.endsWith(`/${normalizedPattern}`) ||
      normalized.includes(`/${normalizedPattern}/`)
    );
  });
}
