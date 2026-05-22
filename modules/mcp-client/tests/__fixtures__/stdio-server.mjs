#!/usr/bin/env node
// Minimal MCP server speaking the stdio transport. Hand-rolled — no SDK
// dependency, since the fixture lives outside any package's node_modules and
// can't reliably resolve workspace dependencies. Lives under __fixtures__ so
// the kernel test runner skips it.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdin/stdout. Supports just
// what tools-call-stdio.yaml needs: initialize, notifications/initialized,
// tools/list, tools/call (echo).

import { stdin, stdout } from "node:process";

stdin.setEncoding("utf8");
let buffer = "";

function write(envelope) {
  stdout.write(JSON.stringify(envelope) + "\n");
}

function handle(message) {
  const { id, method, params } = message ?? {};

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-client-stdio-fixture", version: "0.1.0" },
      },
    });
    return;
  }

  // notifications carry no id — no response.
  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echo the input message back.",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name !== "echo") {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        },
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: String(args.message ?? "") }],
      },
    });
    return;
  }

  if (id !== undefined && id !== null) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      process.stderr.write(`fixture: malformed JSON-RPC: ${err.message}\n`);
    }
  }
});

stdin.on("end", () => process.exit(0));
