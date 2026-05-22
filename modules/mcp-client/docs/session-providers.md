---
description: "Mcp.SessionProvider — pluggable contract for externally-managed MCP session IDs. Consumed by Mcp.HttpClient; concrete providers are user-authored templates."
sidebar_label: Session providers
---

# `Mcp.SessionProvider`

> Examples below assume `mcp-client` is imported as `McpClient`.

A `Telo.Provider` abstract that supplies an externally-sourced MCP session
ID per request. Consumed only by `Mcp.HttpClient` — `Mcp.StdioClient` has no
equivalent session concept (the process lifecycle is the session).

`mcp-client` ships **no bundled concrete providers**. The library exposes the
abstract contract; every concrete (static-from-secret, per-call SQL lookup,
Vault read, OIDC token exchange) is authored by the consuming library as a
`Telo.Definition` template that `extends: McpClient.SessionProvider`. Keeps
this module a transport leaf — no `std/sql`, no other backend pulled in via
a "convenience" provider.

## When to use external session providers

`Mcp.HttpClient` ships **two session modes** keyed by the presence of
`sessionProvider:`:

| Mode               | When to use                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Self-handshake** | The MCP server mints sessions on initialize (or is stateless). Omit `sessionProvider:`. The client owns everything.  |
| **External**       | Session IDs come from outside the kernel — a shared Redis cache, a Vault path, a SQL row, an OIDC token exchange.    |

The self-handshake mode is what most deployments want. Reach for an external
provider when (a) sessions must be shared across kernel instances, or (b) the
session is minted by an upstream auth layer that the client can't observe.

## Abstract contract

```yaml
capability: Telo.Provider
outputType:
  type: object
  required: [sessionId]
  properties:
    sessionId: { type: string }
```

`provide()` is parameterless and must return `{ sessionId: <string> }` on
every call. `Mcp.HttpClient` calls `provider.provide()` **once per
`invoke()`** and forwards the returned ID on the request's `Mcp-Session-Id`
header.

## Authoring a concrete provider

A template-form provider that composes existing kinds (no TypeScript
controller needed):

```yaml
kind: Telo.Definition
metadata: { name: VaultSession }
capability: Telo.Provider
extends: McpClient.SessionProvider
schema:
  type: object
  required: [vaultPath, httpClient]
  properties:
    vaultPath: { type: string }
    httpClient: { type: string, x-telo-ref: "std/http-client#Client" }
resources:
  - kind: HttpClient.Request
    metadata: { name: "${{ self.name }}-read" }
    client: "${{ self.httpClient }}"
    inputs:
      url:    "https://vault/v1/secret/${{ self.vaultPath }}"
      method: GET
provide:
  kind: HttpClient.Request
  name: "${{ self.name }}-read"
result:
  sessionId: "${{ result.body.data.session_id }}"
```

### What the analyzer catches in this example

`Http.Request.outputType` declares `{ status, headers, body }` with `body`
left as an open shape — per-endpoint body shapes aren't statically knowable
to a generic HTTP client. That gives the analyzer two real layers of safety:

- **Top-level typos** (`result.bdoy`, `result.statsus`) are rejected by
  `telo check`; those fields are declared so the chain validator fails closed.
- The mapping into the abstract's `outputType` is checked at definition time:
  misnaming `sessionId` to `sessionid` in the `result:` block surfaces as a
  `TEMPLATE_TARGET_MISMATCH` diagnostic.

What it does **not** catch today: a typo *deeper* inside `body`, e.g.
`result.body.data.session_iid`. `body` is `dyn` past the first hop because
the analyzer has no per-endpoint shape to narrow to. That access fails at
runtime when the field is missing. If your provider needs the deeper access
checked statically, render the body shape with a dedicated `Telo.Definition`
whose `outputType` declares the Vault response — or wait for per-endpoint
typing on `Http.Request` to land.

Wire the provider into a client:

```yaml
kind: McpClient.HttpClient
metadata: { name: RegistryMcp }
url: http://registry.example.com/mcp
sessionProvider: RegistryVaultSession
```

## Refresh policy

External-mode sessions are **not** refreshed by the client. On rejection the
client raises `ERR_MCP_SESSION_INVALID` on the first call — your workflow's
`catches:` block owns whatever refresh / re-fetch logic the source needs.
The client can't refresh what it doesn't own.

## Why no bundled handshake-session kind

The client's self-handshake flow (initialize + cache + re-handshake on
invalidation) lives inside `Mcp.HttpClient`'s controller, not as a separate
`SessionProvider` kind. Same factoring as `Sql.Connection` owning its own
TCP reconnect logic: the handshake lifecycle belongs to the resource that
observes session-invalid responses on the wire. Carving out
`Mcp.HandshakeSession` would create an inverted dependency where the client
tells the provider its session was rejected — awkward when the client can
just handle it itself.

Users who want a stateful MCP session simply **omit** `sessionProvider:`
from their `Mcp.HttpClient`. The client takes over.
