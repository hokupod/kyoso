import { describe, expect, test } from "bun:test";
import { AgentOutputAccumulator } from "../../src/acp/AgentOutputAccumulator.js";

describe("AgentOutputAccumulator", () => {
  test("keeps a single message chunk unchanged without a retry", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk("result", { messageId: "message" });

    expect(accumulator.finalRawText()).toBe("result");
  });

  test("keeps all message chunks in receive order without a retry", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk("a1", {
      messageId: "a",
      phase: "commentary",
    });
    accumulator.addMessageChunk("b1", {
      messageId: "b",
      phase: "final_answer",
    });
    accumulator.addMessageChunk("a2", {
      messageId: "a",
      phase: "final_answer",
    });

    expect(accumulator.finalRawText()).toBe("a1b1a2");
  });

  test("ignores phases when no retry was observed", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk("commentary", {
      messageId: "commentary",
      phase: "commentary",
    });
    accumulator.addMessageChunk("final", {
      messageId: "final",
      phase: "final_answer",
    });

    expect(accumulator.finalRawText()).toBe("commentaryfinal");
  });

  test("keeps only a final-answer segment after a retry", () => {
    const accumulator = new AgentOutputAccumulator();
    const partial = '{"summary":"par';
    accumulator.addMessageChunk(partial, { messageId: "msg-a" });
    const boundary = accumulator.markRetryBoundary();
    accumulator.addMessageChunk('{"summary":"passed"}', {
      messageId: "msg-b",
      phase: "final_answer",
    });

    expect(accumulator.finalRawText()).toBe('{"summary":"passed"}');
    expect(boundary.discardedMessageBytes).toBe(
      Buffer.byteLength(partial, "utf8"),
    );
    expect(accumulator.metrics()).toMatchObject({
      observedStreamRetries: 1,
      discardedRetryMessageBytes: Buffer.byteLength(partial, "utf8"),
    });
  });

  test("discards every partial epoch before the final answer", () => {
    const accumulator = new AgentOutputAccumulator();
    const first = '{"summary":"par';
    const second = '{"summary":"pas';
    accumulator.addMessageChunk(first, { messageId: "msg-a" });
    accumulator.markRetryBoundary();
    accumulator.addMessageChunk(second, { messageId: "msg-b" });
    accumulator.markRetryBoundary();
    accumulator.addMessageChunk('{"summary":"passed"}', {
      messageId: "msg-c",
      phase: "final_answer",
    });

    expect(accumulator.finalRawText()).toBe('{"summary":"passed"}');
    expect(accumulator.metrics()).toMatchObject({
      observedStreamRetries: 2,
      discardedRetryMessageBytes:
        Buffer.byteLength(first, "utf8") + Buffer.byteLength(second, "utf8"),
    });
  });

  test("falls back to unknown segments from the final retry epoch", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk('{"summary":"par', { messageId: "msg-a" });
    accumulator.markRetryBoundary();
    accumulator.addMessageChunk('{"summary":"passed"}', { messageId: "msg-b" });

    expect(accumulator.finalRawText()).toBe('{"summary":"passed"}');
  });

  test("does not return commentary after a retry", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk('{"summary":"par', { messageId: "msg-a" });
    accumulator.markRetryBoundary();
    accumulator.addMessageChunk("still thinking", {
      messageId: "commentary",
      phase: "commentary",
    });

    expect(accumulator.finalRawText()).toBe("");
  });

  test("records a retry with no prior message chunks", () => {
    const accumulator = new AgentOutputAccumulator();

    expect(accumulator.markRetryBoundary()).toEqual({
      discardedMessageBytes: 0,
    });
    expect(accumulator.metrics()).toMatchObject({
      observedStreamRetries: 1,
      discardedRetryMessageBytes: 0,
    });
  });

  test("uses an epoch segment when message IDs are absent", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk('{"summary":"par', {});
    accumulator.markRetryBoundary();
    accumulator.addMessageChunk('{"summary":"passed"}', {});

    expect(accumulator.finalRawText()).toBe('{"summary":"passed"}');
  });

  test("does not retain thought text but records output timestamps", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.noteUpdate();
    accumulator.addThoughtChunk("private reasoning");
    const metrics = accumulator.metrics();

    expect(accumulator.finalRawText()).toBe("");
    expect(typeof metrics.firstOutputAt).toBe("string");
    expect(typeof metrics.lastAcpUpdateAt).toBe("string");
  });

  test("accounts for discarded multibyte UTF-8 text", () => {
    const accumulator = new AgentOutputAccumulator();
    accumulator.addMessageChunk("あ", { messageId: "msg-a" });

    expect(accumulator.markRetryBoundary()).toEqual({
      discardedMessageBytes: 3,
    });
    expect(accumulator.metrics().discardedRetryMessageBytes).toBe(3);
  });
});
