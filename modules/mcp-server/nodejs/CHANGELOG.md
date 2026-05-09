# @telorun/mcp-server

## 0.4.0

### Minor Changes

- 733029e: Add `stateful` flag to `Mcp.HttpEndpoint` and flip the default to stateless. In stateless mode (the new default) every request builds a fresh SDK `Server`+transport pair, no `Mcp-Session-Id` is minted, and the endpoint scales horizontally without sticky session affinity at the load balancer. Set `stateful: true` to keep the v1 behaviour where each session owns an in-memory `Server` keyed by `Mcp-Session-Id` — required for server-pushed notifications, resource subscriptions, and tool inputs that branch on `request.session.id`. The transition is transparent for tools-only consumers; clients that previously relied on session continuity should opt in to `stateful: true` and configure header-based affinity at their LB if they run more than one replica.

## 0.3.0

### Minor Changes

- 019c62a: Add optional `instructions: string` field on `Mcp.HttpEndpoint` and
  `Mcp.StdioServer`. Forwarded to the SDK `Server` constructor's `instructions`
  option and surfaced to clients on `initialize` — compatible MCP clients
  (Claude Desktop, etc.) pass this to their LLM as system context, so it's the
  natural place to ship a primer that teaches the model what the server is and
  how to use its tools without requiring a discovery tool round-trip.

## 0.2.0

### Minor Changes

- 5288f6c: Initial release of the `mcp-server` module.

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
