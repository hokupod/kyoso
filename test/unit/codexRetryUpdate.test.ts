import { describe, expect, test } from "bun:test";
import { parseCodexRetryUpdate } from "../../src/acp/codexRetryUpdate.js";

describe("parseCodexRetryUpdate", () => {
  test("recognizes a structured retry update and extracts its attempt", () => {
    expect(parseCodexRetryUpdate(retryUpdate("Reconnecting... 1/5"))).toEqual({
      message: "Reconnecting... 1/5",
      attempt: 1,
      maxRetries: 5,
    });
  });

  test("uses a direct display field when the structured message is absent", () => {
    expect(
      parseCodexRetryUpdate({
        sessionUpdate: "session_info_update",
        title: "Reconnecting... 2/3",
        _meta: { codex: { error: { willRetry: true } } },
      }),
    ).toEqual({ message: "Reconnecting... 2/3", attempt: 2, maxRetries: 3 });
  });

  test("rejects false or missing retry markers", () => {
    expect(
      parseCodexRetryUpdate({
        sessionUpdate: "session_info_update",
        _meta: { codex: { error: { willRetry: false } } },
      }),
    ).toBeUndefined();
    expect(
      parseCodexRetryUpdate({
        sessionUpdate: "session_info_update",
        _meta: { codex: { error: {} } },
      }),
    ).toBeUndefined();
  });

  test("handles malformed metadata without throwing", () => {
    for (const meta of [[], null, "invalid"]) {
      expect(() =>
        parseCodexRetryUpdate({
          sessionUpdate: "session_info_update",
          _meta: meta,
        }),
      ).not.toThrow();
      expect(
        parseCodexRetryUpdate({
          sessionUpdate: "session_info_update",
          _meta: meta,
        }),
      ).toBeUndefined();
    }
  });

  test("keeps retry recognition when the message format has no attempt", () => {
    expect(
      parseCodexRetryUpdate(retryUpdate("retrying due to disconnect")),
    ).toEqual({ message: "retrying due to disconnect" });
  });

  test("sanitizes control characters and ANSI escape sequences", () => {
    const result = parseCodexRetryUpdate(
      retryUpdate("\u001b[31mReconnecting... 1/5\u001b[0m\u0007"),
    );

    expect(result).toEqual({
      message: "Reconnecting... 1/5",
      attempt: 1,
      maxRetries: 5,
    });
  });

  test("does not treat a non-session-info update as a retry boundary", () => {
    expect(
      parseCodexRetryUpdate({
        sessionUpdate: "agent_message_chunk",
        _meta: { codex: { error: { willRetry: true } } },
      }),
    ).toBeUndefined();
  });
});

function retryUpdate(message: string): unknown {
  return {
    sessionUpdate: "session_info_update",
    _meta: { codex: { error: { willRetry: true, message } } },
  };
}
