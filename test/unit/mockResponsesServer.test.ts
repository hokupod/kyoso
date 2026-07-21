import { describe, expect, test } from "bun:test";
import { startMockResponsesServer } from "../fixtures/mockResponsesServer.js";

const enabled = process.env.KYOSO_CODEX_ACP_MOCK_SSE === "1";
const testIf = enabled ? test : test.skip;

describe("mock Responses server", () => {
  testIf(
    "applies script entries in order and records request JSON",
    async () => {
      const server = await startMockResponsesServer([
        { kind: "error_401" },
        { kind: "complete", text: "mock complete" },
      ]);
      try {
        const first = await postResponses(server.baseUrl, { attempt: 1 });
        expect(first.status).toBe(401);
        expect(await first.json()).toEqual({
          error: {
            code: "invalid_api_key",
            message: "Mock authorization failure",
            param: null,
            type: "authentication_error",
          },
        });

        const second = await postResponses(server.baseUrl, { attempt: 2 });
        expect(second.status).toBe(200);
        expect(await second.text()).toContain("event: response.completed");
        expect(server.requests.map((request) => request.body)).toEqual([
          { attempt: 1 },
          { attempt: 2 },
        ]);
      } finally {
        await server.close();
      }
    },
  );

  testIf("closes active streams and is idempotent", async () => {
    const server = await startMockResponsesServer([{ kind: "idle_forever" }]);
    try {
      const response = await postResponses(server.baseUrl, { idle: true });
      expect(response.status).toBe(200);

      await server.close();
      expect(await response.text()).toBe("");
      await expect(server.close()).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

function postResponses(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
