---
"@telorun/mcp-server": minor
---

Initial release of the `mcp-server` module.

Adds five resource kinds for exposing a Model Context Protocol server from Telo
manifests: `Mcp.StdioServer` (stdio transport, `Telo.Service`), `Mcp.HttpEndpoint`
(Streamable-HTTP transport, `Telo.Mount` on `Http.Server`), and three passive
bundle kinds — `Mcp.Tools`, `Mcp.Resources`, `Mcp.Prompts` (`Telo.Type`). v1 ships
runtime dispatch for `Mcp.Tools`; `Resources` and `Prompts` are schema-only and
gain runtime in v2.

Bundles compose by reference: a transport's `tools:` array can reference multiple
bundles (entries are merged with cross-bundle duplicate detection at init), and a
single bundle can be referenced from both stdio and HTTP transports without
re-declaration. Each tool entry maps the MCP envelope (`request.{name, arguments,
meta, session}`) to any `Telo.Invocable` handler via CEL `inputs:` / `result:` /
`catches:` adapters — the handler stays oblivious to MCP.
