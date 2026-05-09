---
description: "Mcp.HttpEndpoint — Telo.Mount exposing MCP over Streamable HTTP at a path on Http.Server. Stateless by default; opt in to per-session state with `stateful: true`."
sidebar_label: Mcp.HttpEndpoint
---

# `Mcp.HttpEndpoint`

> Examples below assume `mcp-server` is imported as `Mcp` and `http-server` as `Http`.

Mounts an MCP Streamable-HTTP listener at a path on an `Http.Server`. One
endpoint serves multiple concurrent clients. By default the endpoint runs in
**stateless** mode: every request is independent, no session is tracked, and
the deployment scales horizontally without sticky routing. Set `stateful: true`
to opt in to per-session SDK `Server` instances keyed by the `Mcp-Session-Id`
header.

## Schema

```yaml
kind: Mcp.HttpEndpoint
metadata: { name: <EndpointName> }
serverInfo:
  name: <advertised-server-name>
  version: <semver>
instructions: |                              # optional — primer for the client's LLM
  Free-form text surfaced on `initialize`.
stateful: false                              # optional — default false (stateless)
tools: [<Mcp.Tools bundle names>]
resources: [<Mcp.Resources bundle names>]   # v2 runtime
prompts: [<Mcp.Prompts bundle names>]       # v2 runtime
```

### `instructions`

Optional free-form string carried on the SDK `Server`'s `instructions` option.
Compatible MCP clients (Claude Desktop, etc.) surface it to the LLM as system
context on every session. Use it to teach the model what your server is, what
its tools mean, and how to use them — onboarding without requiring the LLM to
call a separate "help" tool first. The same string is returned on every
`initialize` against the endpoint.

### `stateful`

Selects between the two session models below. Defaults to `false` because the
overwhelming majority of MCP endpoints expose tools-only surfaces that don't
benefit from sessions, and the stateless default is the only one that survives
horizontal scaling without bespoke load-balancer configuration.

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

### Stateless (default)

Every POST builds a fresh SDK `Server` + `StreamableHTTPServerTransport`,
handles the request, and disposes both. The transport runs with
`sessionIdGenerator: undefined`, so it never mints an `Mcp-Session-Id` and
ignores any header the client echoes.

| Request                          | Behaviour                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Any POST/GET/DELETE              | Independent: build → handle → dispose. No session map, no affinity required.            |
| Client echoes an `Mcp-Session-Id`| Ignored. The header is treated as informational; nothing is validated against it.       |

This is the right model for tools-only servers and for any deployment running
behind a load balancer without sticky sessions — the registry app behind
`registry.telo.run` runs in this mode for exactly this reason.

`request.session.id` (available in tool `inputs:` CEL) is the empty string in
stateless mode. Tools that branch on session identity belong on a stateful
endpoint.

### Stateful (`stateful: true`)

The endpoint maintains an in-memory map keyed by `Mcp-Session-Id`. Each entry
owns its own SDK `Server` + transport for the lifetime of the session.

| Request                                                           | Behaviour                                                                                                                         |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST without `Mcp-Session-Id` AND body is an `initialize` request | Mint session UUID, build fresh SDK Server + transport, register in session map, return UUID via `Mcp-Session-Id` response header. |
| POST/GET/DELETE with known `Mcp-Session-Id`                       | Route to that session's transport.                                                                                                |
| Any request with unknown `Mcp-Session-Id`                         | 404 with a JSON-RPC -32001 error envelope.                                                                                        |
| POST without `Mcp-Session-Id` and not an `initialize` request     | 400 with a JSON-RPC -32000 error envelope.                                                                                        |

`StreamableHTTPServerTransport.onclose` removes the session from the map. On
`Http.Server` shutdown, the endpoint's `onClose` hook closes every active
session.

> **Horizontal scaling note.** Sessions live in process memory only — they are
> not replicated across instances. If you scale a stateful endpoint to ≥2
> replicas, you must configure header-based session affinity at your load
> balancer (NGINX Plus, AWS ALB, Cloudflare Load Balancing, and most ingress
> controllers all support hashing on the `Mcp-Session-Id` request header).
> Without affinity, follow-up requests will land on instances that don't know
> the session and the client receives -32001 errors. If you don't need session
> state, leave `stateful` at the default and avoid the problem entirely.

## When to opt in to stateful

Reach for `stateful: true` when you actually need session-bound behaviour:

- Server-pushed notifications (logs, progress) over the SSE stream.
- Resource subscriptions or prompt subscriptions that update over time.
- Tool inputs that depend on `request.session.id` to scope handler state.
- Per-session capabilities negotiation that handlers consume.

A registry-style server (only `tools/list` + `tools/call` against pure-read
tools) needs none of those; stateless is the right default.

## v1 limits

- **No idle session GC** (stateful only). Sessions live until `Http.Server` closes. Long-running endpoints will accumulate sessions over time. Idle expiry / max-sessions cap is v2 work.
- **No auth.** Authentication is the host `Http.Server`'s concern (CORS, reverse-proxy auth, future Telo middleware kinds).
- **No `resources` / `prompts` runtime.** Bundles are accepted but must be empty.

## Soft vs hard failures

The same distinction as `Mcp.StdioServer` applies — see [Mcp.Tools](./tools.md):

- `result.isError: true` — handler succeeded but content describes an upstream failure (LLM reads it as natural language).
- `catches:` — handler threw an `InvokeError`; the entry maps it to a JSON-RPC error response.
