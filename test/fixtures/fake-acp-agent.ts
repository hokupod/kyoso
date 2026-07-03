import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";

let initialized = false;

const app = agent({ name: "kyoso-fake-acp-agent" })
  .onRequest(methods.agent.initialize, () => {
    initialized = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  })
  .onRequest(methods.agent.session.new, () => {
    if (!initialized) {
      throw RequestError.internalError({ details: "Not initialized" });
    }
    return {
      sessionId: "fake-session",
    };
  })
  .onRequest(methods.agent.session.prompt, async (ctx) => {
    const manifest = await ctx.client.request(methods.client.fs.readTextFile, {
      sessionId: ctx.params.sessionId,
      path: "context/request.json",
    });
    const selectedFile = await ctx.client.request(
      methods.client.fs.readTextFile,
      {
        sessionId: ctx.params.sessionId,
        path: join(process.cwd(), "src/foo.ts"),
      },
    );
    const opinion = {
      summary:
        manifest.content.includes("review plan") &&
        selectedFile.content.includes("export const foo = 1")
          ? "fake ACP subprocess read snapshot context and selected file"
          : "fake ACP subprocess reviewed the prompt",
      findings: [],
      testsToAdd: ["fake ACP subprocess test"],
      residualRisks: ["fake ACP subprocess residual risk"],
      openQuestions: [],
    };
    await ctx.client.notify(methods.client.session.update, {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "fake-message",
        content: {
          type: "text",
          text: JSON.stringify(opinion),
        },
      },
    });
    return { stopReason: "end_turn" };
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);

const connection = app.connect(stream);
await connection.closed;
