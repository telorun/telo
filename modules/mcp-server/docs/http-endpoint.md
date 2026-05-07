---
description: "Mcp.HttpEndpoint — Telo.Mount exposing MCP over Streamable HTTP at a path on Http.Server. Per-session SDK Server keyed by Mcp-Session-Id header."
sidebar_label: Mcp.HttpEndpoint
---

# `Mcp.HttpEndpoint`

> Examples below assume `mcp-server` is imported as `Mcp` and `http-server` as `Http`.

Mounts an MCP Streamable-HTTP listener at a path on an `Http.Server`. One
endpoint serves multiple concurrent clients; each client owns its own MCP SDK
`Server` instance keyed by the `Mcp-Session-Id` header.

## Schema

```yaml
kind: Mcp.HttpEndpoint
metadata: { name: <EndpointName> }
serverInfo:
  name: <advertised-server-name>
  version: <semver>
tools: [<Mcp.Tools bundle names>]
resources: [<Mcp.Resources bundle names>]   # v2 runtime
prompts: [<Mcp.Prompts bundle names>]       # v2 runtime
```

## Mounting on `Http.Server`

```yaml
kind: Http.Server
metadata: { name: Web }
port: 8080
mounts:
  - { path: /v1, type: <App>.Rest }     # your existing REST API
  - { path: /mcp, type: <App>.McpHttp } # the MCP endpoint
```

`Mcp.HttpEndpoint` duck-types the `register(app, prefix)` signature that
`Http.Server`'s mount loop already calls on `Http.Api`, so it integrates with
zero changes to the host server. A REST API and an MCP endpoint can share the
same port without either being aware of the other.

## Session model

The `StreamableHTTPServerTransport` from the MCP SDK is per-session and
`Server.connect(transport)` is 1:1, so each new client gets its own pair:

| Request                                                           | Behaviour                                                   |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| POST without `Mcp-Session-Id` AND body is an `initialize` request | Mint session UUID, build fresh SDK Server + transport, register in session map, return UUID via `Mcp-Session-Id` response header. |
| POST/GET/DELETE with known `Mcp-Session-Id`                       | Route to that session's transport.                          |
| Any request with unknown `Mcp-Session-Id`                         | 404 with a JSON-RPC error envelope.                         |

`StreamableHTTPServerTransport.onclose` removes the session from the map. On
`Http.Server` shutdown, the endpoint's `onClose` hook closes every active
session.

## v1 limits

- **No idle session GC.** Sessions live until `Http.Server` closes. Long-running endpoints will accumulate sessions over time. Idle expiry / max-sessions cap is v2 work.
- **No auth.** Authentication is the host `Http.Server`'s concern (CORS, reverse-proxy auth, future Telo middleware kinds).
- **No `resources` / `prompts` runtime.** Bundles are accepted but must be empty.

## Soft vs hard failures

The same distinction as `Mcp.StdioServer` applies — see [Mcp.Tools](./tools.md):

- `result.isError: true` — handler succeeded but content describes an upstream failure (LLM reads it as natural language).
- `catches:` — handler threw an `InvokeError`; the entry maps it to a JSON-RPC error response.
