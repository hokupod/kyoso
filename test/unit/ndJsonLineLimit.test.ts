import { describe, expect, test } from "bun:test";
import {
  AcpNdJsonLineLimitError,
  limitAcpNdJsonLineBytes,
} from "../../src/acp/ndJsonLineLimit.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("ACP NDJSON line limit", () => {
  test("accepts exact limits across chunks and resets at newlines", async () => {
    const chunks = [encoder.encode("ab"), encoder.encode("cd\n12\n3456")];
    const output = await readAll(
      limitAcpNdJsonLineBytes(readableFrom(chunks), 4),
    );

    expect(decoder.decode(output)).toBe("abcd\n12\n3456");
  });

  test("rejects a line as soon as accumulated chunks cross the limit", async () => {
    const chunks = [encoder.encode("ab"), encoder.encode("cde")];

    await expect(
      readAll(limitAcpNdJsonLineBytes(readableFrom(chunks), 4)),
    ).rejects.toBeInstanceOf(AcpNdJsonLineLimitError);
  });
});

function readableFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.byteLength;
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
