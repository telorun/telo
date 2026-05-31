# @telorun/mcp-client

## 1.0.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@1.0.0

## 0.2.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.2.0

### Minor Changes

- 8eff8a9: Introduce `@telorun/mcp-client` (v0.1.0) — first-class Model Context Protocol
  client resource kinds. Replaces the hand-rolled `JS.Script` MCP fetchers in
  `modules/mcp-server/tests/http-tool-call.yaml` and
  `apps/registry/tests/e2e/mcp-tools.yaml` with typed kinds:

  - **`Mcp.Client`** (`Telo.Abstract` over `Telo.Invocable`) — generic
    JSON-RPC request contract every transport satisfies.
  - **`Mcp.HttpClient`** — Streamable HTTP transport. Owns lazy `initialize`
    handshake on first call, cached `Mcp-Session-Id`, transparent
    re-handshake on session-invalid responses, best-effort `DELETE` on
    teardown. Switches to external-source mode when a `sessionProvider:` is
    declared.
  - **`Mcp.StdioClient`** — child-process stdio transport. Spawns the server
    at boot, handshakes before `init()` returns, terminates cleanly on
    teardown.
  - **`Mcp.SessionProvider`** (`Telo.Abstract` over `Telo.Provider`) — pluggable
    source for externally-managed MCP session IDs. No bundled concretes;
    consumers author template-form providers via `extends:
McpClient.SessionProvider`.
  - **`Mcp.ToolsCall`** / **`Mcp.ToolsList`** (`Telo.Invocable`) — dispatch
    `tools/call` and `tools/list` through any `Mcp.Client` with zero transport
    knowledge. `Mcp.ToolsCall`'s `outputType` is closed (`content[]` is a
    typed `oneOf` union) so `${{ steps.X.result.content[0].text }}` is
    statically validated end-to-end; soft tool failures (`isError: true`) are
    converted to `ERR_MCP_TOOL_ERROR` throws so the success path never
    observes them.
  - Closed `ERR_MCP_*` error union: `ERR_MCP_TRANSPORT`, `ERR_MCP_PROTOCOL`,
    `ERR_MCP_JSON_RPC_ERROR`, `ERR_MCP_TOOL_ERROR`, `ERR_MCP_SESSION_INVALID`.

  `Mcp.HttpClient` is implemented hand-rolled on top of `fetch` (one POST per
  RPC) rather than via `@modelcontextprotocol/sdk`'s
  `StreamableHTTPClientTransport`. The SDK transport opens a server-pushed
  SSE GET stream on `notifications/initialized` that deadlocks against a
  co-located `Http.Server`'s `app.close()` during teardown — Fastify waits
  for in-flight responses to drain, the SSE GET only closes when
  `Mcp.HttpClient.teardown()` runs, but teardown can't run until the
  parent `with:` scope finishes. The hand-rolled path is also what
  external-provider mode needed anyway, so both modes share one code path
  (`postJsonRpc`) and the SDK/hand-rolled drift concern collapses to a single
  implementation.

  `postJsonRpc` has fetch-stubbed vitest unit-test coverage for every branch
  of the closed `ERR_MCP_*` union: SSE plus application/json envelope
  parsing, 404/410 / JSON-RPC -32001/-32002 → `ERR_MCP_SESSION_INVALID`,
  other 4xx/5xx / unexpected Content-Type / network failure →
  `ERR_MCP_TRANSPORT`, malformed JSON / empty SSE / envelopes missing both
  `result` and `error` → `ERR_MCP_PROTOCOL`, generic JSON-RPC error
  envelopes → `ERR_MCP_JSON_RPC_ERROR`, request `Mcp-Session-Id` header
  forwarding, response session-id capture, and the notification (no-id)
  fire-and-forget path.

  Remaining coverage gap: the end-to-end external `sessionProvider:` flow
  (through the `Mcp.SessionProvider` abstract resolving a template-form
  provider concrete) has no integration test today. A follow-up should add a
  YAML test using a user-authored `Mcp.SessionProvider` concrete plus a
  control HTTP fixture that returns 404 on the second call to verify the
  transparent re-handshake under self-handshake mode too.

  Tightens `Http.Request.outputType` (additive) to declare the canonical Telo
  Response Object — `{ status: integer, headers: Record<string, string>, body:
unknown }` — that the runtime controller already returns. Pure schema-only
  change with no behavioural delta in `@telorun/http-client`; the chain
  validator now catches typos in `status` / `headers` / the top-level `body`
  property of `${{ result.* }}` access against `Http.Request` steps. The
  session-provider Vault example in `modules/mcp-client/docs/session-providers.md`
  relies on this tightening for end-to-end chain validation of
  `${{ result.body.data.session_id }}`.
