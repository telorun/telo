---
"@telorun/mcp-server": minor
---

Add optional `instructions: string` field on `Mcp.HttpEndpoint` and
`Mcp.StdioServer`. Forwarded to the SDK `Server` constructor's `instructions`
option and surfaced to clients on `initialize` — compatible MCP clients
(Claude Desktop, etc.) pass this to their LLM as system context, so it's the
natural place to ship a primer that teaches the model what the server is and
how to use its tools without requiring a discovery tool round-trip.
