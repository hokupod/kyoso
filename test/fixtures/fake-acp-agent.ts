import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import { writeFileSync } from "node:fs";

let initialized = false;
const mode = process.env.FAKE_ACP_MODE ?? "happy";

if (process.env.FAKE_ACP_PID_FILE) {
  writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
}

if (mode === "crash") {
  console.error("auth failed: fake ACP crash");
  process.exit(1);
}

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
    if (mode === "hang") {
      await new Promise(() => {});
    }

    if (mode === "garbage") {
      await ctx.client.notify(methods.client.session.update, {
        sessionId: ctx.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "fake-message",
          content: {
            type: "text",
            text: "this is not json",
          },
        },
      });
      return { stopReason: "end_turn" };
    }

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
      findings: [
        {
          severity: "low",
          category: "test",
          title: "Fake ACP subprocess finding",
          evidence: "fake ACP agent completed the ACP session",
          recommendation: "Keep this integration contract under CI.",
          confidence: "high",
        },
      ],
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
