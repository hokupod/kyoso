import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type MockAttemptScript =
  | { kind: "complete"; text: string }
  | { kind: "early_close" }
  | { kind: "partial_then_close"; partialText: string }
  | { kind: "idle_forever" }
  | { kind: "comment_heartbeat"; intervalMs: number }
  | { kind: "data_drip"; intervalMs: number }
  | { kind: "failed_retryable" }
  | { kind: "error_401" };

type MockRequest = {
  at: number;
  body: unknown;
};

export type MockResponsesServer = {
  baseUrl: string;
  requests: MockRequest[];
  close(): Promise<void>;
};

export async function startMockResponsesServer(
  script: MockAttemptScript[],
): Promise<MockResponsesServer> {
  if (script.length === 0) {
    throw new Error("Mock Responses server requires at least one attempt.");
  }

  const requests: MockRequest[] = [];
  const activeStreams = new Set<() => void>();
  const server = createServer((request, response) => {
    void handleRequest(request, response, script, requests, activeStreams);
  });
  const address = await listen(server);

  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const closeStream of [...activeStreams]) closeStream();
      activeStreams.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock Responses server did not bind a TCP port.");
  }
  return address;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  script: MockAttemptScript[],
  requests: MockRequest[],
  activeStreams: Set<() => void>,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname !== "/v1/responses") {
    response.writeHead(404).end("Not found");
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405).end("Method not allowed");
    return;
  }

  requests.push({
    at: performance.now(),
    body: await readRequestBody(request),
  });
  const attempt = script[Math.min(requests.length - 1, script.length - 1)];
  if (!attempt) {
    response.writeHead(500).end("No mock attempt configured");
    return;
  }
  if (attempt.kind === "error_401") {
    writeErrorResponse(
      response,
      401,
      "invalid_api_key",
      "Mock authorization failure",
      "authentication_error",
    );
    return;
  }
  writeSseResponse(response, attempt, requests.length, activeStreams);
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function writeErrorResponse(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  type = "invalid_request_error",
): void {
  response
    .writeHead(status, {
      "content-type": "application/json",
      "www-authenticate": status === 401 ? "Bearer" : undefined,
    })
    .end(JSON.stringify({ error: { code, message, param: null, type } }));
}

function writeSseResponse(
  response: ServerResponse,
  attempt: Exclude<MockAttemptScript, { kind: "error_401" }>,
  requestNumber: number,
  activeStreams: Set<() => void>,
): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  });
  response.flushHeaders();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let delayedClose: ReturnType<typeof setTimeout> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (interval) clearInterval(interval);
    if (delayedClose) clearTimeout(delayedClose);
    activeStreams.delete(close);
    if (!response.writableEnded) response.end();
  };
  activeStreams.add(close);
  response.once("close", close);
  const mockResponse = responseObject(requestNumber, "in_progress", []);
  const writeEvent = (event: string, data: unknown): void => {
    if (closed) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const writeComment = (): void => {
    if (closed) return;
    response.write(": OPENROUTER PROCESSING\n\n");
  };

  if (attempt.kind === "idle_forever") return;
  if (attempt.kind === "comment_heartbeat") {
    writeComment();
    interval = setInterval(writeComment, attempt.intervalMs);
    return;
  }
  if (attempt.kind === "data_drip") {
    writeEvent("response.created", {
      type: "response.created",
      response: mockResponse,
    });
    interval = setInterval(() => {
      writeEvent("response.in_progress", {
        type: "response.in_progress",
        response: mockResponse,
      });
    }, attempt.intervalMs);
    return;
  }

  writeEvent("response.created", {
    type: "response.created",
    response: mockResponse,
  });
  if (attempt.kind === "failed_retryable") {
    writeEvent("response.failed", {
      type: "response.failed",
      response: {
        ...mockResponse,
        error: {
          code: "server_error",
          message: "Mock retryable failure",
          type: "server_error",
        },
        status: "failed",
      },
    });
    close();
    return;
  }
  if (attempt.kind === "early_close") {
    close();
    return;
  }

  const outputItem = responseOutputItem(requestNumber, "in_progress", "");
  writeEvent("response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: outputItem,
  });
  writeEvent("response.content_part.added", {
    type: "response.content_part.added",
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });

  if (attempt.kind === "partial_then_close") {
    writeEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: outputItem.id,
      output_index: 0,
      content_index: 0,
      delta: attempt.partialText,
    });
    close();
    return;
  }

  writeCompletedResponse(writeEvent, mockResponse, outputItem, attempt.text);
  delayedClose = setTimeout(close, 10);
}

function writeCompletedResponse(
  writeEvent: (event: string, data: unknown) => void,
  response: Record<string, unknown>,
  outputItem: Record<string, unknown> & { id: string },
  text: string,
): void {
  const completedOutputItem = responseOutputItem(
    Number(String(outputItem.id).split("_").at(-1) ?? "0"),
    "completed",
    text,
  );
  writeEvent("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  writeEvent("response.output_text.done", {
    type: "response.output_text.done",
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeEvent("response.content_part.done", {
    type: "response.content_part.done",
    item_id: outputItem.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text, annotations: [] },
  });
  writeEvent("response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item: completedOutputItem,
  });
  writeEvent("response.completed", {
    type: "response.completed",
    response: {
      ...response,
      output: [completedOutputItem],
      status: "completed",
    },
  });
}

function responseObject(
  requestNumber: number,
  status: "in_progress" | "completed",
  output: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    id: `resp_mock_${requestNumber}`,
    object: "response",
    created_at: 1_700_000_000,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "openai/gpt-5.4",
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: null,
    status,
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  };
}

function responseOutputItem(
  requestNumber: number,
  status: "in_progress" | "completed",
  text: string,
): Record<string, unknown> & { id: string } {
  return {
    id: `msg_mock_${requestNumber}`,
    type: "message",
    role: "assistant",
    status,
    content:
      status === "completed"
        ? [{ type: "output_text", text, annotations: [] }]
        : [],
  };
}
