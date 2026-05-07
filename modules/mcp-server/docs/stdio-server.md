---
description: "Mcp.StdioServer — Telo.Service that owns an MCP SDK Server bound to stdin/stdout. One process, one client, one implicit session."
sidebar_label: Mcp.StdioServer
---

# `Mcp.StdioServer`

> Examples below assume `mcp-server` is imported as `Mcp`.

Owns an MCP SDK `Server` bound to a `StdioServerTransport` over the
controller's `stdin`/`stdout`. Designed for desktop clients (Claude Desktop,
Cursor, …) that spawn the server as a child process.

## Lifecycle

- `init()` — resolves every bundle ref in `tools:` / `resources:` / `prompts:`, validates entries (within-bundle and cross-bundle uniqueness), builds one SDK Server and registers each entry as a handler.
- `run()` — connects the SDK Server to a `StdioServerTransport`, mints a synthetic session UUID (so `request.session.id` is always defined for CEL inputs), and acquires a kernel hold via `ctx.acquireHold()` so the process stays up.
- `teardown()` — closes the transport (releasing the hold via `transport.onclose`) and closes the SDK Server.

stdin EOF (the parent closing the pipe) triggers `transport.onclose`, which
releases the hold and lets the kernel exit cleanly.

## Schema

```yaml
kind: Mcp.StdioServer
metadata: { name: <ServerName> }
serverInfo:
  name: <advertised-server-name>
  version: <semver>
tools: [<Mcp.Tools bundle names>]
resources: [<Mcp.Resources bundle names>]   # v2 runtime
prompts: [<Mcp.Prompts bundle names>]       # v2 runtime
```

In v1, `resources:` and `prompts:` arrays are accepted in the schema but
must be empty — runtime dispatch lands in v2.

## Minimal example

```yaml
kind: Telo.Application
metadata: { name: my-stdio-mcp }
targets: [Server]
---
kind: Telo.Import
metadata: { name: Mcp }
source: ../modules/mcp-server
---
kind: Telo.Import
metadata: { name: JS }
source: ../modules/javascript
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
      properties: { city: { type: string } }
      required: [city]
    handler: { kind: JS.Script, name: GetWeatherImpl }
    inputs: { city: "${{ request.arguments.city }}" }
    result:
      content:
        - { type: text, text: "${{ result.summary }}" }
```

## Differences from `Mcp.HttpEndpoint`

| Aspect             | `Mcp.StdioServer`                      | `Mcp.HttpEndpoint`                       |
| ------------------ | -------------------------------------- | ---------------------------------------- |
| Capability         | `Telo.Service` (owns transport + run) | `Telo.Mount` (mounts on `Http.Server`)   |
| Lifecycle          | Process lives until stdin EOF          | Sessions live until `Http.Server` closes |
| Sessions           | One implicit, synthetic UUID           | Per-client, header-routed                |
| SDK Server cardinality | One per process                    | One per session                          |
