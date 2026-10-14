#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) whose
// prompts/list answers `{ items: [] }` — a result without a `prompts` array.
// Hand-rolled: the fixture resolves no package.

import { stdin, stdout } from "node:process";

stdin.setEncoding("utf8");
let buffer = "";

function write(envelope) {
  stdout.write(JSON.stringify(envelope) + "\n");
}

function handle({ id, method, params } = {}) {
  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { prompts: {} },
        serverInfo: { name: "ai-mcp-malformed-prompts-fixture", version: "0.1.0" },
      },
    });
    return;
  }
  if (id === undefined || id === null) return;
  if (method === "prompts/list") {
    write({ jsonrpc: "2.0", id, result: { items: [] } });
    return;
  }
  write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
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
