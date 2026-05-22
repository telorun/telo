# MCP Client

Model Context Protocol (MCP) client resource kinds for Telo: Streamable HTTP +
stdio transports, transport-agnostic `tools/call` and `tools/list` dispatch.

The module mirrors `mcp-server`'s factoring: **transport kinds**
(`Mcp.HttpClient`, `Mcp.StdioClient`) own the connection and session lifecycle;
**RPC kinds** (`Mcp.ToolsCall`, `Mcp.ToolsList`) reference any concrete
client and dispatch through it without transport knowledge. A third transport
(WebSocket, in-process, …) drops in as another `Mcp.Client` implementation —
nothing in any consumer changes.

## Capabilities at a glance

| Kind                  | Capability       | Role                                                                          |
| --------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `Mcp.Client`          | `Telo.Abstract`  | Generic JSON-RPC request contract; every transport satisfies it.              |
| `Mcp.HttpClient`      | `Telo.Invocable` | Streamable HTTP transport. Owns lazy handshake + session cache + DELETE.      |
| `Mcp.StdioClient`     | `Telo.Invocable` | Child-process stdio transport. Owns spawn + handshake + clean teardown.       |
| `Mcp.SessionProvider` | `Telo.Abstract`  | Pluggable source for externally-managed MCP session IDs (HTTP-only).          |
| `Mcp.ToolsCall`       | `Telo.Invocable` | Dispatches `tools/call` through a referenced `Mcp.Client`.                    |
| `Mcp.ToolsList`       | `Telo.Invocable` | Dispatches `tools/list` through a referenced `Mcp.Client`.                    |

## Minimal Streamable HTTP example

```yaml
kind: Telo.Application
metadata: { name: my-mcp-app, version: 1.0.0 }
targets: [GetWeather]
---
kind: Telo.Import
metadata: { name: McpClient }
source: std/mcp-client@0.1.0
---
kind: Telo.Import
metadata: { name: Run }
source: std/run@1.0.0
---
kind: McpClient.HttpClient
metadata: { name: RemoteMcp }
url: https://mcp.example.com/mcp
headers:
  authorization: "Bearer ${{ secrets.MCP_TOKEN }}"
clientInfo: { name: my-mcp-app, version: 1.0.0 }
---
kind: McpClient.ToolsCall
metadata: { name: CallGetWeather }
client: RemoteMcp
---
# `targets:` must point at a Runnable, so wrap the tool call in a
# Run.Sequence. Inputs live on the step, not the McpClient.ToolsCall
# resource itself.
kind: Run.Sequence
metadata: { name: GetWeather }
steps:
  - name: Call
    inputs:
      name: get_weather
      arguments: { city: Atlantis }
    invoke: { kind: McpClient.ToolsCall, name: CallGetWeather }
```

`Mcp.HttpClient` self-handshakes on the first `invoke()` (no `sessionProvider`
declared), caches the `Mcp-Session-Id` for the life of the resource, and
transparently re-handshakes if the server invalidates the session.

## Minimal stdio example

```yaml
kind: McpClient.StdioClient
metadata: { name: LocalMcp }
command: /usr/local/bin/some-mcp-server
args: ["--stdio"]
env:
  MCP_LOG_LEVEL: debug
clientInfo: { name: my-mcp-app, version: 1.0.0 }
---
kind: McpClient.ToolsCall
metadata: { name: CallGetWeather }
client: LocalMcp
```

The child process is spawned and handshaked at boot; swap the `client:`
reference in the `Run.Sequence` step from the HTTP example above and the
same `targets: [GetWeather]` flow runs unchanged against stdio.

## Error contract

Both `Mcp.ToolsCall` and `Mcp.ToolsList` surface a closed error union via
`InvokeError`s so `catches:` blocks have a stable code surface:

| Code                      | When                                                                            |
| ------------------------- | ------------------------------------------------------------------------------- |
| `ERR_MCP_TRANSPORT`       | Network failure, non-2xx HTTP, unexpected Content-Type, child-process exit.     |
| `ERR_MCP_PROTOCOL`        | Malformed JSON-RPC envelope (missing `jsonrpc`, neither `result` nor `error`).  |
| `ERR_MCP_JSON_RPC_ERROR`  | Server returned a JSON-RPC error envelope (`error.code`, `error.message`).      |
| `ERR_MCP_TOOL_ERROR`      | Server returned `isError: true` in the success envelope (soft tool failure).    |
| `ERR_MCP_SESSION_INVALID` | HTTP-only: server rejected the session after the client's internal retry.       |

A response with `isError: true` is converted to `ERR_MCP_TOOL_ERROR` so the
success path never observes it — the `outputType` of `Mcp.ToolsCall` does not
include an `isError` field.

See [docs/http-client.md](./docs/http-client.md),
[docs/stdio-client.md](./docs/stdio-client.md),
[docs/tools-call.md](./docs/tools-call.md),
[docs/tools-list.md](./docs/tools-list.md), and
[docs/session-providers.md](./docs/session-providers.md) for per-kind reference.

## Out of scope for v1

- `resources/read`, `prompts/get`, `sampling`, server notifications, roots. v1 covers `tools/call` + `tools/list`.
- Per-tool typing of `structuredContent` (open shape in v1).
- Dynamic / rotating header values (future `headerProvider:` slot).
- Bidirectional / long-lived subscriptions exposed as kernel-level abstractions.
