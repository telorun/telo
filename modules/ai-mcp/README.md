# AI MCP

Bridges an MCP server to the [`Ai.ToolProvider`](../ai/docs/ai-tool-provider.md) contract, so an [`Ai.Agent`](../ai/docs/ai-agent.md) can discover and call a whole MCP server's tools.

## Why use this

- **Discovery, not declaration** — point an agent at a server and it gets every advertised tool; no per-tool manifest entry.
- **Agent stays MCP-agnostic** — `AiMcp.ToolProvider` implements the generic `Ai.ToolProvider` abstract; `@telorun/ai` never depends on MCP.
- **Transport-pluggable** — wraps any `Mcp.Client` (`Mcp.StdioClient`, `Mcp.HttpClient`).
- **The only coupling point** — this is the single module that depends on both `@telorun/ai` and `@telorun/mcp-client`; the two cores stay single-purpose.

## Kinds

| Kind                  | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `AiMcp.ToolProvider`  | An `Ai.ToolProvider` backed by an `Mcp.Client` (tools/list + tools/call). |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-app, version: 1.0.0 }
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
imports:
  Ai: std/ai@^0.4.0
  AiOpenai: std/ai-openai@^0.4.0
  Mcp: std/mcp-client@^0.4.0
  AiMcp: std/ai-mcp@^0.4.0
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: "${{ secrets.openaiApiKey }}"
---
kind: Mcp.StdioClient
metadata: { name: FilesMcp }
command: npx
args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
clientInfo: { name: my-app, version: 1.0.0 }
---
kind: AiMcp.ToolProvider
metadata: { name: FileTools }
client: { kind: Mcp.StdioClient, name: FilesMcp }
---
kind: Ai.Agent
metadata: { name: Assistant }
model: { kind: AiOpenai.OpenaiModel, name: Gpt4o }
toolProviders:
  - provider: { kind: AiMcp.ToolProvider, name: FileTools }
    prefix: "fs_"
```

## Reference

- [`AiMcp.ToolProvider`](docs/ai-mcp-tool-provider.md) — fields and behavior.
- [`Ai.Agent`](../ai/docs/ai-agent.md) — the consuming agent loop.
- [`Ai.ToolProvider`](../ai/docs/ai-tool-provider.md) — the contract this implements.
