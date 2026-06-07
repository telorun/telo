# MCP Client

Model Context Protocol (MCP) client resource kinds for Telo: Streamable HTTP and stdio transports, transport-agnostic `tools/call` and `tools/list` dispatch.

## Why use this

- **Transport-agnostic dispatch** — `Mcp.ToolsCall` and `Mcp.ToolsList` reference any concrete client; HTTP, stdio, and future transports are interchangeable.
- **Self-managed session lifecycle** — `Mcp.HttpClient` handshakes lazily, caches `Mcp-Session-Id`, and re-handshakes transparently on session-invalid responses.
- **Pluggable session providers** — supply MCP session IDs from secrets, SQL, Vault, or OIDC by declaring an `Mcp.SessionProvider` implementation; no controller code required.
- **Long-lived stdio children** — `Mcp.StdioClient` spawns and supervises a child MCP server with a clean shutdown grace period.
- **Closed error contract** — a stable, enumerated set of `ERR_MCP_*` codes for `catches:` blocks.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Mcp.Client` | Abstract JSON-RPC request contract every transport satisfies. |
| `Mcp.HttpClient` | Streamable HTTP transport with lazy handshake, session caching, and DELETE on teardown. |
| `Mcp.StdioClient` | Child-process stdio transport with spawn, handshake, and clean teardown. |
| `Mcp.SessionProvider` | Abstract provider for externally-managed MCP session IDs (HTTP-only). |
| `Mcp.ToolsCall` | Dispatches `tools/call` through a referenced `Mcp.Client`. |
| `Mcp.ToolsList` | Dispatches `tools/list` through a referenced `Mcp.Client`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-mcp-app, version: 1.0.0 }
imports:
  McpClient: std/mcp-client@0.3.1
  Run: std/run@0.7.0
targets: [ !ref GetWeather ]
secrets:
  MCP_TOKEN: { type: string }
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
client: !ref RemoteMcp
---
kind: Run.Sequence
metadata: { name: GetWeather }
steps:
  - name: Call
    inputs:
      name: get_weather
      arguments: { city: Atlantis }
    invoke: !ref CallGetWeather
```

## Reference

- [`Mcp.HttpClient`](docs/http-client.md) — Streamable HTTP transport, handshake, session cache.
- [`Mcp.StdioClient`](docs/stdio-client.md) — child-process spawn, env, shutdown grace.
- [`Mcp.ToolsCall`](docs/tools-call.md) — request/response shape, error mapping.
- [`Mcp.ToolsList`](docs/tools-list.md) — listing the tools an MCP server advertises.
- [Session providers](docs/session-providers.md) — externally-managed MCP session IDs.

## Error Contract

Both `Mcp.ToolsCall` and `Mcp.ToolsList` surface a closed error union via `InvokeError`s so `catches:` blocks have a stable code surface:

| Code | When |
| --- | --- |
| `ERR_MCP_TRANSPORT` | Network failure, non-2xx HTTP, unexpected Content-Type, child-process exit. |
| `ERR_MCP_PROTOCOL` | Malformed JSON-RPC envelope (missing `jsonrpc`, neither `result` nor `error`). |
| `ERR_MCP_JSON_RPC_ERROR` | Server returned a JSON-RPC error envelope (`error.code`, `error.message`). |
| `ERR_MCP_TOOL_ERROR` | Server returned `isError: true` in the success envelope (soft tool failure). |
| `ERR_MCP_SESSION_INVALID` | HTTP-only: server rejected the session after the client's internal retry. |

A response with `isError: true` is converted to `ERR_MCP_TOOL_ERROR` so the success path never observes it — the `outputType` of `Mcp.ToolsCall` does not include an `isError` field.

## Out of Scope for v1

- `resources/read`, `prompts/get`, `sampling`, server notifications, roots — v1 covers `tools/call` and `tools/list`.
- Per-tool typing of `structuredContent` (open shape in v1).
- Dynamic / rotating header values (future `headerProvider:` slot).
- Bidirectional / long-lived subscriptions exposed as kernel-level abstractions.
