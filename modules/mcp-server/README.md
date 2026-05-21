# MCP Server

Model Context Protocol (MCP) server resource kinds for Telo: stdio + Streamable HTTP transports, composable tool/resource/prompt bundles.

The module mirrors the `http-server` shape: **transport kinds**
(`Mcp.StdioServer`, `Mcp.HttpEndpoint`) own the listener and a session model;
**bundle kinds** (`Mcp.Tools`, `Mcp.Resources`, `Mcp.Prompts`) are passive
declarations that compose by reference. A single bundle can be referenced by
both stdio and HTTP transports without re-declaration.

## Capabilities at a glance

| Kind               | Capability     | Role                                                                    |
| ------------------ | -------------- | ----------------------------------------------------------------------- |
| `Mcp.StdioServer`  | `Telo.Service` | Listens on stdin/stdout (one client per process). Owns one SDK Server.  |
| `Mcp.HttpEndpoint` | `Telo.Mount`   | Mounts on `Http.Server` at a path. Per-session SDK Server (Streamable). |
| `Mcp.Tools`        | `Telo.Type`    | Bundle of tool entries dispatched via `tools/call`.                     |
| `Mcp.Resources`    | `Telo.Type`    | Bundle of resource entries (schema'd in v1, runtime in v2).             |
| `Mcp.Prompts`      | `Telo.Type`    | Bundle of prompt entries (schema'd in v1, runtime in v2).               |

## Minimal stdio example

```yaml
kind: Telo.Application
metadata: { name: my-stdio-mcp }
targets: [Server]
---
kind: Telo.Import
metadata: { name: Mcp }
source: std/mcp-server@0.4.2
---
kind: Telo.Import
metadata: { name: JS }
source: std/javascript@0.3.2
---
kind: Mcp.StdioServer
metadata: { name: Server }
serverInfo: { name: my-stdio-mcp, version: 1.0.0 }
tools: [WeatherTools]
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
      required: [city]
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

## Tool entries

Each `Mcp.Tools.entries[]` row declares everything MCP advertises plus the
glue that bridges between MCP envelopes and your handler's domain types:

| Field             | Purpose                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `name`            | Tool identifier sent in `tools/call`.                                                      |
| `description`     | Human-readable summary surfaced to MCP clients.                                            |
| `argumentsSchema` | JSON Schema validated by the MCP SDK on every call.                                        |
| `handler`         | Any `Telo.Invocable` (e.g. `JS.Script`, `Run.Sequence`, `Ai.Text`).                        |
| `inputs`          | CEL map: MCP request → handler input. Sees `request.{name,arguments,meta,session}`.        |
| `result`          | CEL map: handler output → full MCP `CallToolResult`. Sees `result` and `request`.          |
| `catches`         | Maps thrown `InvokeError`s into JSON-RPC error responses (distinct from `result.isError`). |

`isError` on `result` signals a _soft_ tool failure where the LLM should read
the failure as content. `catches:` is for actual `throw`s and produces a
JSON-RPC error.

## Composition

- **Multiple bundles into one transport.** `tools: [WeatherTools, DatabaseTools]` merges entries from both bundles. Duplicate names across bundles throw at init.
- **One bundle into multiple transports.** Reference the same `Mcp.Tools` from both `Mcp.StdioServer` and `Mcp.HttpEndpoint` — registrations are independent per-transport, no shared runtime state.

## Onboarding clients with `instructions`

Both transports accept an optional `instructions: <string>` field that is
surfaced to MCP clients on `initialize` (carried on the SDK `Server`'s
`instructions` option). Compatible clients pass this to their LLM as system
context, so it's the natural place to ship a primer about what the server is
and how to use its tools. See [`docs/http-endpoint.md`](./docs/http-endpoint.md)
and [`docs/stdio-server.md`](./docs/stdio-server.md).

## Out of scope for v1

- `Mcp.Resources` and `Mcp.Prompts` runtime dispatch — schemas land in v1, controllers in v2.
- Streaming tool content / progress notifications.
- Streamable HTTP idle-session GC + max-sessions cap (sessions live until `Http.Server` shuts down).
- Server-initiated `sampling`, `roots`, OAuth.
- A polymorphic `Telo.Mount` dispatch protocol — `Mcp.HttpEndpoint` duck-types `register(app, prefix)` to satisfy `Http.Server`'s mount loop today.

See the [Mcp.StdioServer](./docs/stdio-server.md), [Mcp.HttpEndpoint](./docs/http-endpoint.md), and [Mcp.Tools](./docs/tools.md) pages for per-kind reference.
