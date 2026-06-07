---
description: "AiMcp.ToolProvider: bridges an MCP server (any Mcp.Client) to the Ai.ToolProvider contract so an Ai.Agent can discover and call its tools."
sidebar_label: AiMcp.ToolProvider
---

# `AiMcp.ToolProvider`

> Examples assume aliases `Ai` (`@telorun/ai`), `AiMcp` (`@telorun/ai-mcp`), `AiOpenai` (`@telorun/ai-openai`), and `Mcp` (`@telorun/mcp-client`).

`AiMcp.ToolProvider` is the bridge between MCP and agents: it wraps any `Mcp.Client` as an [`Ai.ToolProvider`](../../ai/docs/ai-tool-provider.md), so an [`Ai.Agent`](../../ai/docs/ai-agent.md) discovers and calls a whole MCP server's tools without knowing anything about MCP.

- `listTools()` → the server's `tools/list` (each tool's `inputSchema` becomes the model-facing `parameters`).
- `callTool(name, args)` → the server's `tools/call`; the returned content is fed back to the model. A tool error (`isError`) raises `ERR_MCP_TOOL_ERROR`, surfaced through the agent's `onToolError`.

This is the **only** module that depends on both `@telorun/ai` and `@telorun/mcp-client` — `@telorun/ai` stays MCP-agnostic, `@telorun/mcp-client` stays a pure transport.

```yaml
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: "${{ secrets.openaiApiKey }}"
---
# Any Mcp.Client — stdio or Streamable HTTP.
kind: Mcp.StdioClient
metadata: { name: FilesMcp }
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
clientInfo: { name: my-app, version: 1.0.0 }
---
# Bridge the server's tools into the Ai.ToolProvider contract.
kind: AiMcp.ToolProvider
metadata: { name: FileTools }
client: !ref FilesMcp
---
kind: Ai.Agent
metadata: { name: Assistant }
model: !ref Gpt4o
toolProviders:
  - provider: !ref FileTools
    prefix: "fs_"                        # → fs_read_file, fs_list_directory, …
    include: [read_file, list_directory] # optional allowlist
```

## Manifest fields

| Field    | Type                  | Required | Purpose                                                            |
| -------- | --------------------- | -------- | ------------------------------------------------------------------ |
| `client` | ref (`Mcp.Client`)    | yes      | Any `Mcp.Client` (`Mcp.HttpClient`, `Mcp.StdioClient`, …).         |

The discovered tools are **statically opaque** — their set and argument schemas are known only at run time, advertised by the server. They are validated at the server boundary, not by the analyzer. Per-tool `prefix`/`include`/`exclude` and the dispatch loop live on the consuming [`Ai.Agent`](../../ai/docs/ai-agent.md).
