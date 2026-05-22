---
description: "Mcp.HttpClient — Streamable HTTP transport for MCP. Owns the handshake, session cache, and re-handshake-on-invalidation."
sidebar_label: Mcp.HttpClient
---

# `Mcp.HttpClient`

> Examples below assume `mcp-client` is imported as `McpClient`.

A long-lived MCP client backed by the Streamable HTTP transport. Owns the
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
- **Best-effort DELETE on teardown.** Sends a session-terminate DELETE per
  the Streamable HTTP spec on `teardown()` (self-handshake mode only).

## Schema

```yaml
kind: McpClient.HttpClient
metadata: { name: <Name> }
url: <string>                          # MCP endpoint URL
headers:                               # optional, static headers (see below)
  authorization: "Bearer ${{ secrets.MCP_TOKEN }}"
sessionProvider: <ProviderName>        # optional; switches to external mode
clientInfo:                            # optional; advertised during initialize
  name: my-client
  version: 1.0.0
protocolVersion: "2024-11-05"          # optional; defaults to the pinned constant ("2024-11-05" at v0.1.0)
```

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
codes verbatim. See the [README error contract](../README.md#error-contract).
