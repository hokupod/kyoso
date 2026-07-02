export type ParsedArgs = {
  command: string;
  flags: Record<string, string | boolean | string[]>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags: ParsedArgs["flags"] = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item) continue;
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = rest[index + 1];
    const value = next && !next.startsWith("--") ? next : true;
    if (value !== true) index += 1;
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      flags[key] = [String(existing), String(value)];
    }
  }
  return { command, flags };
}

export function stringFlag(
  flags: ParsedArgs["flags"],
  key: string,
): string | undefined {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return typeof value === "string" ? value : undefined;
}

export function booleanFlag(flags: ParsedArgs["flags"], key: string): boolean {
  return flags[key] === true;
}

export function stringArrayFlag(
  flags: ParsedArgs["flags"],
  key: string,
): string[] {
  const value = flags[key];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
