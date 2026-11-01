# MCP Server

Model Context Protocol (MCP) server resource kinds for Telo: stdio and Streamable HTTP transports, composable tool/resource/prompt bundles.

## Why use this

- **Transport-pluggable** — the same tool bundle works over stdio (one client per process) or Streamable HTTP (multi-session) without re-declaration.
- **Composable bundles** — several tool, resource or prompt bundles can be merged into one transport; one bundle can be referenced by multiple transports.
- **Declarative tool entries** — `argumentsSchema`, handler, `inputs:` mapping, `result:` mapping, and `catches:` rendering are all manifest fields.
- **Onboarding-friendly** — optional `instructions` field surfaces a server primer to MCP clients on `initialize`.
- **Mount on `Http.Server`** — `Mcp.HttpEndpoint` is a standard `Telo.Mount`, slotted under any path prefix.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Mcp.StdioServer` | stdin/stdout transport (one client per process). |
| `Mcp.HttpEndpoint` | Streamable HTTP transport mounted on `Http.Server` at a path. |
| `Mcp.Tools` | Passive bundle of tool entries dispatched via `tools/call`. |
| `Mcp.Resources` | Passive bundle of resource entries — fixed URIs and URI templates — read via `resources/read`. |
| `Mcp.Prompts` | Passive bundle of prompt entries rendered via `prompts/get`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: MyStdioMcp, version: 1.0.0 }
imports:
  Mcp: oci://ghcr.io/telorun/mcp-server@0.9.0
  Run: oci://ghcr.io/telorun/run@0.13.0
targets: [ !ref server ]
---
kind: Mcp.StdioServer
metadata: { name: server }
serverInfo: { name: my-stdio-mcp, version: 1.0.0 }
tools: [ !ref WeatherTools ]
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
    handler: !ref getWeatherImpl
    inputs:
      city: !cel "request.arguments.city"
    result:
      content:
        - type: text
          text: !cel "result.summary"
---
kind: Run.Value
metadata: { name: getWeatherImpl }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [city]
    properties: { city: { type: string } }
value:
  summary: !interpolate "Sunny in ${{ inputs.city }}"
```

## Reference

- [`Mcp.StdioServer`](docs/stdio-server.md) — stdin/stdout transport, instructions, lifecycle.
- [`Mcp.HttpEndpoint`](docs/http-endpoint.md) — Streamable HTTP transport, stateful/stateless modes.
- [`Mcp.Tools`](docs/tools.md) — tool-entry fields, `inputs:` / `result:` / `catches:` semantics.
- [`Mcp.Resources`](docs/resources.md) — fixed URIs and templates, binary contents, unknown-URI errors.
- [`Mcp.Prompts`](docs/prompts.md) — prompt arguments and the rendered message list.

## Composition Notes

- **Multiple bundles into one transport.** `tools: [ !ref WeatherTools, !ref DatabaseTools ]` merges entries from both bundles. A tool name, resource URI or prompt name declared twice — in one bundle or across the bundles of one transport — is reported by `telo check` and refused at boot.
- **One bundle into multiple transports.** Reference the same `Mcp.Tools` from both `Mcp.StdioServer` and `Mcp.HttpEndpoint` — registrations are independent per-transport, no shared runtime state.
- **`isError` vs. `catches:`.** `isError: true` on `result` signals a soft tool failure rendered as content. `catches:` is for actual `throw`s and produces a JSON-RPC error envelope.

## Out of Scope for v1

- Resource subscriptions, `listChanged` notifications and `completion/complete` — the listings are fixed at boot.
- Streaming tool content / progress notifications.
- Streamable HTTP idle-session GC and max-sessions cap (sessions live until `Http.Server` shuts down).
- Server-initiated `sampling`, `roots`, OAuth.
- A polymorphic `Telo.Mount` dispatch protocol — `Mcp.HttpEndpoint` duck-types `register(app, prefix, requestScope)` to satisfy `Http.Server`'s mount loop today.
