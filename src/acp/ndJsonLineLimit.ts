import { MAX_AGENT_OUTPUT_BYTES } from "../core/constants.js";

const JSON_STRING_MAX_ESCAPE_EXPANSION = 6;
const ACP_NDJSON_ENVELOPE_BYTES = 2 * 1_048_576;
const NEWLINE_BYTE = 0x0a;

// A permitted 1 MiB text chunk can expand to six ASCII bytes per input byte
// when JSON-escaped. Keep another 2 MiB for the JSON-RPC envelope and ACP
// metadata while bounding the SDK's otherwise-unlimited LineBuffer.
export const MAX_ACP_NDJSON_LINE_BYTES =
  MAX_AGENT_OUTPUT_BYTES * JSON_STRING_MAX_ESCAPE_EXPANSION +
  ACP_NDJSON_ENVELOPE_BYTES;

export class AcpNdJsonLineLimitError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`ACP NDJSON line exceeded ${maxLineBytes} bytes.`);
    this.name = "AcpNdJsonLineLimitError";
  }
}

export function limitAcpNdJsonLineBytes(
  input: ReadableStream<Uint8Array>,
  maxLineBytes = MAX_ACP_NDJSON_LINE_BYTES,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("ACP NDJSON line limit must be a positive integer.");
  }

  let pendingLineBytes = 0;
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        let start = 0;
        for (;;) {
          const newlineIndex = chunk.indexOf(NEWLINE_BYTE, start);
          const end = newlineIndex === -1 ? chunk.byteLength : newlineIndex;
          pendingLineBytes += end - start;
          if (pendingLineBytes > maxLineBytes) {
            throw new AcpNdJsonLineLimitError(maxLineBytes);
          }
          if (newlineIndex === -1) break;
          pendingLineBytes = 0;
          start = newlineIndex + 1;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
