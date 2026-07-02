export type TruncationResult = {
  content: string;
  truncated: boolean;
  bytes: number;
};

export function truncateUtf8(input: string, maxBytes: number): TruncationResult {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(input);
  const budget = Math.max(0, maxBytes);
  if (encoded.byteLength <= budget) {
    return { content: input, truncated: false, bytes: encoded.byteLength };
  }

  const marker = `\n[KYOSO_TRUNCATED at ${budget} bytes]`;
  const markerBytes = encoder.encode(marker);
  if (markerBytes.byteLength >= budget) {
    const content = decodeUtf8Prefix(encoded, budget);
    return { content, truncated: true, bytes: encoder.encode(content).byteLength };
  }

  const sliced = decodeUtf8Prefix(encoded, budget - markerBytes.byteLength);
  const content = `${sliced}${marker}`;
  return {
    content,
    truncated: true,
    bytes: encoder.encode(content).byteLength,
  };
}

function decodeUtf8Prefix(encoded: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = Math.max(0, maxBytes); end > 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      // Retry after backing off to a UTF-8 character boundary.
    }
  }
  return "";
}
