import { writeFileSync } from "node:fs";

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error("probe output path is required");
}

const observedKeys = [
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "PATH",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "KYOSO_PROBE_DENIED_SENTINEL",
];

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      cwd: process.cwd(),
      env: Object.fromEntries(
        observedKeys.map((key) => [key, process.env[key] ?? null]),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdin.setEncoding("utf8");
let buffer = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    handleRequest(JSON.parse(line));
  }
});

function handleRequest(request) {
  if (request.id === undefined) return;

  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "kyoso-plugin-runtime-probe", version: "1.0.0" },
    });
    return;
  }

  if (request.method === "tools/list") {
    respond(request.id, {
      tools: [
        {
          name: "probe_environment",
          description: "Return the runtime probe environment.",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    });
    return;
  }

  if (request.method === "tools/call") {
    respond(request.id, {
      content: [{ type: "text", text: "probe ready" }],
    });
    return;
  }

  if (request.method === "resources/list") {
    respond(request.id, { resources: [] });
    return;
  }

  if (request.method === "resources/templates/list") {
    respond(request.id, { resourceTemplates: [] });
    return;
  }

  if (request.method === "prompts/list") {
    respond(request.id, { prompts: [] });
    return;
  }

  respondError(request.id, -32601, `unsupported method: ${request.method}`);
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  );
}
