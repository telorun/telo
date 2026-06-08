# MCP Server

Model Context Protocol (MCP) server resource kinds for Telo: stdio and Streamable HTTP transports, composable tool/resource/prompt bundles.

## Why use this

- **Transport-pluggable** — the same tool bundle works over stdio (one client per process) or Streamable HTTP (multi-session) without re-declaration.
- **Composable bundles** — multiple `Mcp.Tools` bundles can be merged into one transport; one bundle can be referenced by multiple transports.
- **Declarative tool entries** — `argumentsSchema`, handler, `inputs:` mapping, `result:` mapping, and `catches:` rendering are all manifest fields.
- **Onboarding-friendly** — optional `instructions` field surfaces a server primer to MCP clients on `initialize`.
- **Mount on `Http.Server`** — `Mcp.HttpEndpoint` is a standard `Telo.Mount`, slotted under any path prefix.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Mcp.StdioServer` | stdin/stdout transport (one client per process). |
| `Mcp.HttpEndpoint` | Streamable HTTP transport mounted on `Http.Server` at a path. |
| `Mcp.Tools` | Passive bundle of tool entries dispatched via `tools/call`. |
| `Mcp.Resources` | Bundle of resource entries (schema'd in v1, runtime in v2). |
| `Mcp.Prompts` | Bundle of prompt entries (schema'd in v1, runtime in v2). |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-stdio-mcp, version: 1.0.0 }
imports:
  Mcp: std/mcp-server@0.7.0
  JS: std/javascript@0.5.0
targets: [ !ref Server ]
---
kind: Mcp.StdioServer
metadata: { name: Server }
serverInfo: { name: my-stdio-mcp, version: 1.0.0 }
tools: [ WeatherTools ]
---
kind: Mcp.Tools
metadata: { name: WeatherTools }
entries:
  - name: get_weather
    description: Get current weather for a city.
    argumentsSchema:
      type: object
      properties:
        city: { type: string }
      required: [ city ]
    handler:
      kind: JS.Script
      name: GetWeatherImpl
    inputs:
      city: "${{ request.arguments.city }}"
    result:
      content:
        - type: text
          text: "${{ result.summary }}"
```

## Reference

- [`Mcp.StdioServer`](docs/stdio-server.md) — stdin/stdout transport, instructions, lifecycle.
- [`Mcp.HttpEndpoint`](docs/http-endpoint.md) — Streamable HTTP transport, stateful/stateless modes.
- [`Mcp.Tools`](docs/tools.md) — tool-entry fields, `inputs:` / `result:` / `catches:` semantics.

## Composition Notes

- **Multiple bundles into one transport.** `tools: [WeatherTools, DatabaseTools]` merges entries from both bundles. Duplicate names across bundles throw at init.
- **One bundle into multiple transports.** Reference the same `Mcp.Tools` from both `Mcp.StdioServer` and `Mcp.HttpEndpoint` — registrations are independent per-transport, no shared runtime state.
- **`isError` vs. `catches:`.** `isError: true` on `result` signals a soft tool failure rendered as content. `catches:` is for actual `throw`s and produces a JSON-RPC error envelope.

## Out of Scope for v1

- `Mcp.Resources` and `Mcp.Prompts` runtime dispatch — schemas land in v1, controllers in v2.
- Streaming tool content / progress notifications.
- Streamable HTTP idle-session GC and max-sessions cap (sessions live until `Http.Server` shuts down).
- Server-initiated `sampling`, `roots`, OAuth.
- A polymorphic `Telo.Mount` dispatch protocol — `Mcp.HttpEndpoint` duck-types `register(app, prefix)` to satisfy `Http.Server`'s mount loop today.
