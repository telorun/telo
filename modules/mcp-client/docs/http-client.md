---
description: "Mcp.HttpClient — Streamable HTTP transport for MCP. Owns the handshake, session cache, and re-handshake-on-invalidation."
sidebar_label: Mcp.HttpClient
---

# `Mcp.HttpClient`

> Examples below assume `mcp-client` is imported as `McpClient`.

A long-lived MCP client backed by the Streamable HTTP transport. It carries
`tools/call`, `tools/list`, `prompts/list` and `prompts/get`, each as one
JSON-RPC POST whose `result` payload is the invocation's result. Owns the
entire HTTP transport lifecycle:

- **Lazy handshake.** No network I/O at `init()`. The first `invoke()` does
  the MCP `initialize` + `notifications/initialized` handshake.
- **Session cache.** For stateful endpoints, the minted `Mcp-Session-Id`
  header is cached on the controller instance and reused on every subsequent
  call. Stateless endpoints (no header on `initialize`) work transparently.
- **Re-handshake on invalid.** When the server rejects the session (HTTP 404
  or 410, or JSON-RPC `-32001` / `-32002`), the cached session is dropped, a
  fresh handshake runs, and the failed request is retried once. A second
  rejection surfaces as `ERR_MCP_SESSION_INVALID`.
- **Cancellation.** A cancelled invocation aborts its POST, then POSTs
  `notifications/cancelled` for that request id on the same session (a dropped
  connection alone does not cancel under Streamable HTTP), and rejects with
  `ERR_INVOKE_CANCELLED`. A failure to deliver the notification is logged at
  `warn`. A cancelled invocation still waiting on the shared handshake stops
  waiting; the handshake completes for the other callers.
- **Best-effort DELETE on teardown.** The session is registered as `init()`'s
  effect, so unwinding sends a session-terminate DELETE per the Streamable HTTP
  spec (self-handshake mode only).

## Schema

```yaml
kind: McpClient.HttpClient
metadata: { name: <Name> }
url: <string>                          # MCP endpoint URL
headers:                               # optional, static headers (see below)
  authorization: !interpolate "Bearer ${{ secrets.MCP_TOKEN }}"
sessionProvider: <ProviderName>        # optional; switches to external mode
clientInfo:                            # optional; advertised during initialize
  name: my-client
  version: 1.0.0
protocolVersion: "2024-11-05"          # optional; defaults to the pinned constant ("2024-11-05" at v0.1.0)
retry:                                 # optional; omitted means no retry
  attempts: 3
  initialDelay: 250ms
  jitter: full
```

## `retry:`

`retry:` is the shared retry policy (`attempts`, `initialDelay`, `factor`,
`maxDelay`, `jitter`, `nonRetryable`, `retryAfter`) that a step's `retry:` takes.
It re-attempts a whole invocation, handshake included, when it fails with
`ERR_MCP_TRANSPORT` in one of two ways:

- **No response arrived** — the network layer failed (connection reset or
  refused, DNS or TLS failure).
- **A gateway answered 502, 503 or 504.**

Everything else surfaces at once: other HTTP statuses, an unexpected content
type, JSON-RPC and tool errors, protocol errors, `ERR_MCP_SESSION_INVALID`
(which the client already handles with its one re-handshake), a code listed in
`nonRetryable`, and cancellation — a cancelled backoff ends with
`ERR_INVOKE_CANCELLED`. An exhausted budget raises the last failure. `retryAfter`
sees the failure as `error` (code `ERR_MCP_TRANSPORT`).

**A retried request may reach the server more than once.** When the connection
dies after the request was sent, the server may already have run the tool. Enable
`retry:` for servers whose tools are safe to repeat (read-only ones, for instance).
`Mcp.StdioClient` has no `retry:`: its child process is the session, so there is
nothing to reconnect.

## Session modes

| `sessionProvider` | Lifecycle                                                                                                   | Re-handshake on invalid                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **absent**        | Client handshakes, caches the session, reuses it. Re-handshakes once if the server invalidates the session. | Yes — owned by the client, one retry.    |
| **present**       | Each `invoke()` calls `provider.provide()` and forwards the returned `sessionId` on the request.            | No — workflow's `catches:` owns refresh. |

External-mode sessions are minted outside the client's process (Redis, Vault,
SQL row, OIDC) so the client can't refresh them transparently. See
[Session Providers](./session-providers.md) for the abstract contract.

## Static `headers:`

`headers:` is evaluated once at controller init and fixed for the life of the
client. Dynamic / rotating header values (refreshing bearer tokens, signed
URLs) need a future `headerProvider:` slot — not in v1. If you must rotate a
token today, declare it as a `Config.Env` secret and re-deploy.

## `snapshot()` surface

`Mcp.HttpClient` exposes `{ url, sessionProviderName, protocolVersion }` from
its `snapshot()`. Notably absent: the cached `Mcp-Session-Id`. Session IDs
(internal-cache or provider-fetched) are never exposed to CEL.

## Errors

`Mcp.ToolsCall` and `Mcp.ToolsList` re-throw the client's `ERR_MCP_*`
codes verbatim, and a direct `prompts/list` / `prompts/get` raises them
itself — a JSON-RPC error answer, which is what a server offering no prompts
sends for them, is `ERR_MCP_JSON_RPC_ERROR`. See the [README error contract](../README.md#error-contract).
