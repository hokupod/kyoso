export const REDACTION = "[KYOSO_REDACTED]";

export function redactValue(text: string, pattern: RegExp): { text: string; count: number } {
  let count = 0;
  const redacted = text.replace(pattern, () => {
    count += 1;
    return REDACTION;
  });
  return { text: redacted, count };
}
