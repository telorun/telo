# MCP Client Module — Initial Design

Ship a `modules/mcp-client/` standard-library module that replaces the two
hand-rolled `JS.Script` MCP fetchers (`modules/mcp-server/tests/http-tool-call.yaml`
and `apps/registry/tests/e2e/mcp-tools.yaml`) with first-class resource kinds.
Driven by the failure analyzed in [`Expression … failed: No such key: content`](../../../apps/registry/tests/e2e/mcp-tools.yaml#L220):
the scripts' permissive `outputType` (`result: { type: object, additionalProperties: true }`)
collapses to CEL `dyn`, so the analyzer cannot statically reject access into a
result envelope that's empty at runtime. A typed client kind fixes the class of
bug, not just this instance.

**Prerequisite plans** (must land in this order before mcp-client can ship):

1. [`analyzer/nodejs/plans/template-internal-cel-validation.md`](../../../analyzer/nodejs/plans/template-internal-cel-validation.md) —
   brings template internals (`resources:`, `invoke:`, `run:`, `provide:`)
   into the analyzer's validation pipeline and registers `self` as a typed
   CEL variable derived from each definition's `schema:`. Without this,
   every `${{ self.X }}` reference inside every user-written
   `Mcp.SessionProvider` template (mcp-client ships none itself — see §3)
   is a runtime-only failure.
2. [`kernel/nodejs/plans/provider-provide-template.md`](../../../kernel/nodejs/plans/provider-provide-template.md) —
   tightens `Telo.Provider` to require `provide()` and adds the
   `provide:` template target. Builds on (1) for its analyzer changes.

mcp-client lands on top of both, inheriting end-to-end static type
checking: a typo in a user-authored `Mcp.SessionProvider` template's
`result.sessionId` mapping — including typos inside `${{ result.body.data.X }}`
when the target is `Http.Request` — is rejected by `telo check` before the
manifest ever runs. (The chain-type narrowing inside that
`result.body.data.X` access depends on `Http.Request` declaring its
`outputType`; this plan ships that tightening **in scope** as a
co-shipped change to `modules/http-client/` — see §5's "Co-shipped:
tighten Http.Request.outputType" sub-section.)

## 1. Goals

- One canonical MCP client surface used by every Telo manifest that calls an
  MCP server (tests today; real consumers later).
- `outputType` schemas tight enough that `${{ steps.X.result.content[0].type }}`
  is statically checked end-to-end.
- Error envelopes surface as `InvokeError` throws (caught via `catches:` or
  step retry), never as silently-empty success shapes. Failure at the
  protocol layer is structurally distinct from success — the analyzer should
  not have to reason about it.
- Session handling splits cleanly along ownership: stateful sessions
  whose lifecycle the client owns (handshake, cache, transparent re-handshake
  on invalidation) live inside `Mcp.HttpClient` itself, exactly the way
  `Sql.Connection` owns its TCP reconnect logic. Externally-sourced sessions
  (Redis, Vault, OIDC, a SQL row) are pluggable via the `SessionProvider`
  abstract — manifest authors compose them in pure YAML, no TypeScript
  controller required.
- Mirrors the `mcp-server` factoring (transport kinds + bundle kinds) so the
  two modules feel like one family.

## 2. Non-goals (v1)

- `resources/read`, `prompts/get`, `sampling`, notifications, roots. v1 covers
  `tools/call` + `tools/list`. Other RPCs land when something actually calls
  them.
- Bidirectional/long-lived sessions exposed as a kernel-level abstraction
  (subscribed notifications, server→client sampling). v1 surfaces the session
  ID, nothing more.
- Dynamic / refreshable `Authorization` (or any other) headers on
  `Mcp.HttpClient`. The `headers:` map is evaluated at compile time, so the
  values are fixed for the life of the client. Rotating bearer tokens, mTLS
  rotation, or signed-URL-style request headers need a separate
  Provider-backed `headerProvider:` (same factoring as `sessionProvider:` but
  for arbitrary header values). Pull this in when the first consumer asks —
  this plan deliberately leaves the slot open rather than shipping a
  half-typed map.
- Per-tool typing of `Mcp.ToolsCall.outputType.structuredContent`. The MCP
  spec ties `structuredContent` to a per-tool `outputSchema` that mcp-client
  doesn't know statically; v1 carries it as `additionalProperties: true`
  (acknowledged dyn leak — see §3.4). The typed-tool follow-up is sketched
  in §3.4's `structuredContent` comment.

Library coordinates: `metadata.namespace: std`, `metadata.name: mcp-client`. Referenced from `x-telo-ref` slots as `std/mcp-client#<Kind>`.

## 3. Resource kinds (v1)

```
Mcp.Client          (Telo.Abstract over Telo.Invocable, typed JSON-RPC request)
  ↑ extends ─────────────────────────────────────────────────────────────
    Mcp.HttpClient        (TS controller)  ←  Streamable HTTP transport
    Mcp.StdioClient       (TS controller)  ←  stdio child-process transport

Mcp.SessionProvider (Telo.Abstract over Telo.Provider, sessionId contract)
  ↑ extends ─────────────────────────────────────────────────────────────
    user-defined providers (template, any library)  ←  composed from existing kinds

Mcp.ToolsCall   (Telo.Invocable)  ←  tools/call against a referenced Mcp.Client
Mcp.ToolsList   (Telo.Invocable)  ←  tools/list against a referenced Mcp.Client
```

mcp-client ships two transport concretes from day one — `Mcp.HttpClient` and
`Mcp.StdioClient` — both extending the `Mcp.Client` abstract. The abstract is
over `Telo.Invocable`, not `Telo.Provider`: every transport implements a
generic `invoke({ method, params })` that issues one JSON-RPC request and
returns the parsed `result` payload (errors throw — §4). `Mcp.ToolsCall` and
`Mcp.ToolsList` delegate to `client.invoke()` and have **zero transport
knowledge** — JSON-RPC framing, session handling, SSE parsing (HTTP), stdio
framing, content-type negotiation, and reconnect-on-invalidation all live
one level down, inside each transport's controller. Adding a third
transport (WebSocket, in-process, …) means shipping a new Invocable concrete
and changing nothing in any consumer.

mcp-client ships **no bundled session-provider concretes**. The library
exposes only the `Mcp.SessionProvider` abstract; every concrete (static
value from a secret, SELECT against a SQL row, Vault lookup, OIDC exchange)
is authored by the consuming library as a template that `extends:
Mcp.SessionProvider`. Keeps the module a transport leaf with no downstream
dependency on `std/sql` or any other backend.

### 3.1 `Mcp.Client` (Telo.Abstract over Telo.Invocable)

One typed contract every transport satisfies: a generic JSON-RPC request
method taking `{ method, params }` and returning the parsed `result`
payload. JSON-RPC framing, session lifecycle, SSE parsing (HTTP), stdio
framing, and content-type negotiation are all internal to each concrete.

```yaml
kind: Telo.Abstract
metadata: { name: Client }
capability: Telo.Invocable
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: false
    required: [method]
    properties:
      method:
        type: string
        # Closed v1 enum keeps the two session modes (SDK-backed self-handshake
        # and hand-rolled external-provider) in lock-step: a manifest that
        # calls an unsupported method is a static error, not a runtime
        # ERR_MCP_PROTOCOL whose surface depends on whether sessionProvider:
        # is set. Widen this enum in the same change that adds the
        # corresponding transport dispatch.
        enum: [tools/call, tools/list]
      params:
        type: object
        additionalProperties: true
outputType:
  kind: Type.JsonSchema
  schema:
    # The JSON-RPC success `result` payload, verbatim. Each MCP RPC has its
    # own result shape (tools/call vs tools/list vs resources/read), so the
    # abstract stays open here at an internal controller-to-controller
    # boundary. Narrowing happens in the Mcp.ToolsCall / Mcp.ToolsList outputTypes that
    # consume this generically — those are the surfaces user CEL reads
    # from, and they are tight (§3.4, §3.5).
    type: object
    additionalProperties: true
```

`outputType` being open here is **not** the dyn leak the bug report names:
the only callers of `Mcp.Client.invoke()` are `Mcp.ToolsCall` and
`Mcp.ToolsList`, both TypeScript controllers that programmatically reshape
the payload into their own tight `outputType`. User CEL never reads from
`Mcp.Client.invoke()` directly.

The throws contract (§4) attaches to every `Mcp.Client` implementation:
protocol-level errors and tool-level errors surface as `InvokeError`s, never
as soft "success with `isError: true`" envelopes.

### 3.2 `Mcp.HttpClient` (Telo.Invocable, Streamable HTTP transport)

Owns the entire HTTP transport lifecycle: lazy `initialize` handshake on
first call, cached `Mcp-Session-Id` for stateful endpoints, transparent
re-handshake on session-invalid responses, best-effort `DELETE` on
teardown. Session handling forks on the presence of `sessionProvider:`.

```yaml
kind: Mcp.HttpClient
metadata: { name: RegistryMcp }
url: http://registry.telo.localhost:8060/mcp
headers:
  authorization: "Bearer ${{ resources.Env.token }}"
sessionProvider: RegistrySession   # optional, any kind extending Mcp.SessionProvider
clientInfo: { name: telo-test, version: 1.0.0 }
protocolVersion: "2024-11-05"      # optional; defaults to a pinned constant (HttpClient is hand-rolled)
```

| `sessionProvider` | Session lifecycle | Re-handshake on invalid |
| --- | --- | --- |
| **absent** | First `invoke()` performs `initialize` + `notifications/initialized`, caches the returned `Mcp-Session-Id` on the controller instance, and reuses it on subsequent calls. If a JSON-RPC response indicates session-invalid, the controller invalidates the cache, re-handshakes, and retries the original request once. Second failure throws `ERR_MCP_SESSION_INVALID`. Stateless endpoints (no session header issued on initialize) are supported transparently — no cache, no header on subsequent calls. | Yes — owned by the controller, one retry. |
| **present** | Each `invoke()` calls `sessionProvider.provide()` and forwards the returned `sessionId` on the request. The controller never handshakes. | No — provider sources sessions externally (DB row, Vault, secret); the client can't refresh what it doesn't own. Consumer's workflow-level `catches:` owns refresh policy. |

The session-invalid retry loop lives **inside `invoke()`**, so there is no
back-channel between `Mcp.ToolsCall` and the client. `ToolsCall.invoke()`
calls `client.invoke({ method: "tools/call", params: ... })`, the client
handles retry internally if needed, and either returns the success payload
or throws. ToolsCall sees one shape and one error contract regardless of
mode and regardless of transport — the same pattern `Sql.Connection`
uses to absorb its TCP reconnect logic, kept here at the level where the
session-invalid signal is actually observed (on the wire, inside the
client's response parser).

Methods (TS controller):

- `init()` validates configuration; no network I/O at boot.
- `invoke({ method, params })` implements the `Mcp.Client` contract. Posts
  JSON-RPC to `url`, parses `application/json` or `text/event-stream`,
  handles the session lifecycle internally, returns the parsed `result`.
- `snapshot()` exposes `{ url, sessionProviderName, protocolVersion }`.
  **Does not** expose any session ID — neither internal-cache nor
  provider-fetched IDs leak to CEL.
- `teardown()` issues a best-effort `DELETE` against the MCP endpoint for
  any cached self-handshake session (per the Streamable HTTP spec) and
  clears internal session state. External-provider sessions are not the
  client's to delete.

`sessionProvider` is a `type: string` reference field (per the stdlib's
`Http.Request.client` / `Mcp.HttpEndpoint.tools` convention) with
`x-telo-ref: "std/mcp-client#SessionProvider"`, so the analyzer enforces
that the target extends the abstract while keeping the manifest spelling
concise.

`headers:` is evaluated at controller init time and fixed for the life of
the client. Dynamic / rotating headers (refreshing bearer tokens, signed
URLs) require a future `headerProvider:` slot — same factoring as
`sessionProvider:` but for arbitrary header values — which this plan
deliberately leaves open rather than shipping a half-typed map. The eventual
shape: a `Telo.Provider` returning `{ headers: Record<string, string> }`,
called from inside `invoke()` per-request and merged on top of the static
`headers:` map.

### 3.3 `Mcp.StdioClient` (Telo.Invocable, stdio child-process transport)

Spawns and owns a long-lived MCP-server child process; speaks
newline-delimited JSON-RPC over stdin/stdout (per the MCP stdio transport
spec). The stdio connection itself is the session — no `Mcp-Session-Id`,
no handshake retry, no `sessionProvider:` slot. The process lifecycle
replaces the HTTP session lifecycle entirely.

```yaml
kind: Mcp.StdioClient
metadata: { name: LocalMcp }
command: /usr/local/bin/some-mcp-server
args: ["--stdio", "--cwd", "/srv"]
env:                              # optional; merged into the child's environment
  MCP_LOG_LEVEL: debug
clientInfo: { name: telo-test, version: 1.0.0 }
shutdownGraceMs: 5000             # optional, default 5000
```

Lifecycle:

- `init()` spawns the child via Node's `child_process.spawn(command, args,
  { env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] })`.
  Performs the MCP `initialize` + `notifications/initialized` handshake on
  stdin/stdout before returning. A child that exits during `init()`, or
  whose initialize response is malformed, makes `init()` throw — the kernel
  surfaces it as a boot failure with captured stderr in the error payload.
  No lazy first-call handshake: stdio MCP is a long-lived peer, and failing
  to handshake at boot is identical in spirit to a database connection
  that can't pool at startup.
- `invoke({ method, params })` writes a framed JSON-RPC request to stdin,
  awaits the matching response (correlated by `id`) on stdout, returns the
  parsed `result`. Errors map to the same throws contract HttpClient uses
  (§4), except `ERR_MCP_SESSION_INVALID` is unreachable here — there are no
  session IDs to invalidate. Concurrent calls are serialized by a per-
  controller request-id counter and a `Map<id, pendingResolve>`; out-of-
  order responses are matched by id, not by call ordering.
- `snapshot()` exposes `{ command, argv, pid }`. `pid` is a useful debug
  surface that doesn't leak credentials. `env` is **not** exposed — the
  user-supplied map can carry secrets. The MCP protocol version is
  negotiated by the SDK during the initialize handshake; there is no
  manifest-level override (HttpClient keeps one because it speaks the
  protocol hand-rolled).
- `teardown()` sends `SIGTERM`, waits up to `shutdownGraceMs` for clean
  exit, then `SIGKILL`. Stdout/stderr streams are drained and closed. Any
  in-flight `invoke()` calls reject with `ERR_MCP_TRANSPORT`.

Stderr is forwarded to the kernel log at `debug` level per-line (not
buffered in full), so a chatty server doesn't grow controller memory.
Stderr is not part of any user-facing surface — manifest authors who need
to inspect server logs run the server out-of-band.

Because `Mcp.StdioClient` implements the same `Mcp.Client` contract,
`Mcp.ToolsCall` and `Mcp.ToolsList` work against it byte-for-byte the
same as against `Mcp.HttpClient` — no consumer changes, no ToolsCall
branching. Users who run an MCP server as a local subprocess simply swap
`Mcp.HttpClient` for `Mcp.StdioClient` in their manifest; nothing
downstream notices.

### 3.4 `Mcp.ToolsCall` (Telo.Invocable)

The replacement for the hand-rolled `tools/call` block.

```yaml
kind: Telo.Definition
metadata: { name: ToolsCall }
capability: Telo.Invocable
schema:
  type: object
  additionalProperties: false
  required: [client]
  properties:
    client:
      x-telo-ref: "std/mcp-client#Client"   # any Mcp.Client implementation
```

`schema:` carries the static config (the client reference); `inputType:` / `outputType:`
shape the runtime call.

```yaml
inputType:
  type: object
  properties:
    name:      { type: string }              # tool name
    arguments: { type: object, additionalProperties: true }
  required: [name]

outputType:
  type: object
  additionalProperties: false
  properties:
    content:
      type: array
      items:
        # Closed-variant content union, keyed by `type`. What the v1 chain
        # validator catches today: wholly-undeclared accesses like
        # `${{ steps.X.result.content[0].bogus }}` are rejected — the
        # validator unions properties across all `oneOf` branches
        # (`analyzer/nodejs/src/schema-compat.ts` lines 278-281) and `bogus`
        # matches none. What it does NOT yet catch in v1: cross-variant
        # access — `${{ steps.X.result.content[0].data }}` against an item
        # whose runtime `type` is `text` is accepted because the validator
        # doesn't narrow by the `type` discriminator (line 199 returns
        # `dyn` for `oneOf` typing). Discriminator-aware narrowing in
        # `schema-compat.ts` is tracked as a follow-up; once it lands the
        # full headline ("a typed client kind fixes the class of bug")
        # extends to per-variant access. v1 already shrinks the dyn surface
        # from "everything past `result`" to "everything past a content
        # variant boundary."
        oneOf:
          - type: object
            additionalProperties: false
            required: [type, text]
            properties:
              type: { const: text }
              text: { type: string }
          - type: object
            additionalProperties: false
            required: [type, data, mimeType]
            properties:
              type: { const: image }
              data:     { type: string, contentEncoding: base64 }
              mimeType: { type: string }
          - type: object
            additionalProperties: false
            required: [type, data, mimeType]
            properties:
              type: { const: audio }
              data:     { type: string, contentEncoding: base64 }
              mimeType: { type: string }
          - type: object
            additionalProperties: false
            required: [type, uri]
            properties:
              type:        { const: resource_link }
              uri:         { type: string }
              name:        { type: string }
              description: { type: string }
              mimeType:    { type: string }
          - type: object
            additionalProperties: false
            required: [type, resource]
            properties:
              type: { const: resource }
              resource:
                type: object
                additionalProperties: false
                required: [uri]
                properties:
                  uri:      { type: string }
                  mimeType: { type: string }
                  text:     { type: string }
                  blob:     { type: string, contentEncoding: base64 }
    structuredContent:
      # Acknowledged v1 dyn leak. The MCP spec ties `structuredContent` to
      # a per-tool `outputSchema` declared by the server, so its shape is
      # not knowable to mcp-client statically. v2 path: introduce
      # `Mcp.Tool` (Telo.Abstract) carrying `argumentsSchema` and
      # `outputSchema`, and a typed `Mcp.ToolsCallTyped` variant that uses
      # `x-telo-schema-from` to pull the referenced tool's outputSchema
      # into this property's effective schema. Until then, callers reading
      # `${{ result.structuredContent.X }}` get dyn typing on `X`. v1
      # callers who want closed typing read `content` only (which is
      # tightened above).
      type: object
      additionalProperties: true
  required: [content]
```

`isError` is intentionally absent from `outputType`. A server response with
`isError: true` is converted to an `ERR_MCP_TOOL_ERROR` throw (§4), so the
success path never observes it. Removing the field eliminates the dead-code
shape where callers branch on `result.isError` against a value that's always
false.

Inputs **do not** include `sessionId`. Session selection is entirely the
client's concern. This is the change that unlocks static analysis: every
value exposed to callers has a typed schema, and "where the session came
from" is not a per-invocation decision the manifest needs to express.

Controller flow (sketch — actual implementation lives in
`tools-call-controller.ts`):

```ts
async invoke(inputs: { name: string; arguments?: object }) {
  const result = await this.client.invoke({
    method: "tools/call",
    params: { name: inputs.name, arguments: inputs.arguments ?? {} },
  });
  // Mcp.Client handles framing, session lifecycle (HTTP) or process I/O
  // (stdio), content-type negotiation, and session-invalidation retry
  // transparently. We only consume the success `result` payload.
  if (result.isError) throw mcpToolError(result);
  return { content: result.content, structuredContent: result.structuredContent };
}
```

ToolsCall has zero transport knowledge and zero session knowledge. It
delegates to `client.invoke()` and reshapes the success payload to its
declared `outputType`. Whether the referenced client is HTTP (with self-
handshake or external `sessionProvider:`) or stdio is invisible at this
layer — that distinction is internal to the client's `invoke()`. Adding a
third transport later requires no changes here.

`ERR_MCP_TOOL_ERROR` is the one error class ToolsCall originates itself
(soft tool failures aren't a transport concern, so the client passes the
raw payload through and ToolsCall converts `isError: true` into a throw).
Every other `ERR_MCP_*` code (§4) originates inside `Mcp.Client.invoke()`
and propagates through untouched.

No `SessionProvider` TypeScript type leaks out of the HttpClient package:
the only code that calls `sessionProvider.provide()` is the HttpClient
controller, and the call goes through the SDK's `ProviderInstance`
interface that already exists for every `Telo.Provider`.

### 3.5 `Mcp.ToolsList` (Telo.Invocable)

Same `schema:` (single `client:` ref) and same throws contract as
`Mcp.ToolsCall`. Delegates to `client.invoke({ method: "tools/list" })`.
Takes no inputs:

```yaml
inputType:
  type: object
  additionalProperties: false
  properties: {}

outputType:
  type: object
  additionalProperties: false
  required: [tools]
  properties:
    tools:
      type: array
      items:
        type: object
        additionalProperties: false
        required: [name, inputSchema]
        properties:
          name:        { type: string }
          description: { type: string }
          inputSchema: { type: object, additionalProperties: true }
```

`inputSchema` stays open because the inner JSON Schema is per-tool and
unknown statically.

### 3.6 `Mcp.SessionProvider` (Telo.Abstract)

Consumed only by `Mcp.HttpClient` — `Mcp.StdioClient`'s schema doesn't accept
a `sessionProvider:` field (stdio has no equivalent session concept).

The abstract defines the contract — `provide()` is parameterless, only the
return shape is typed:

```yaml
kind: Telo.Abstract
metadata: { name: SessionProvider }
capability: Telo.Provider
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: false
    properties:
      sessionId: { type: string }
    required: [sessionId]
```

That is the entire surface mcp-client publishes for session sourcing. No
bundled concretes ship in this module. Every concrete session provider —
static-value-from-a-secret, per-call SQL SELECT, Vault read, OIDC token
exchange — is authored by the consuming library as a `Telo.Definition` that
`extends: Mcp.SessionProvider` and implements `provide()` through the
template machinery added by the kernel prerequisite plan
([provider-provide-template.md](../../../kernel/nodejs/plans/provider-provide-template.md)).
This keeps mcp-client a transport leaf — no `std/sql`, no `std/http-client`,
no other backend pulled in via a "convenience" provider.

**No bundled handshake-session kind either.** The client's self-handshake
flow (initialize + notifications/initialized + cache + re-handshake on
invalidation) lives inside `Mcp.HttpClient`'s controller, not as a separate
SessionProvider kind. Reason: the handshake lifecycle is owned by the
resource that observes session-invalid responses on the wire — same
factoring as `Sql.Connection` owning its own TCP reconnect logic. Carving
out `Mcp.HandshakeSession` as a separate provider would create an inverted
dependency where the client tells the provider its session was rejected,
which is awkward and unnecessary when the client can just handle it itself.
Users who want a stateful MCP session simply omit `sessionProvider:` from
their `Mcp.HttpClient` — the client takes over.

**Example user-defined provider** — a Vault-backed lookup that composes
`Http.Request` to fetch a `sessionId` at provide-time. Because the
http-client co-prerequisite (§10) tightens `Http.Request.outputType` to the
canonical Telo Response Object, `${{ result.body.data.session_id }}` is
fully chain-validated end-to-end — a typo (`session_iid`) is rejected by
`telo check` before the manifest runs:

```yaml
kind: Telo.Definition
metadata: { name: VaultSession }
capability: Telo.Provider
extends: Mcp.SessionProvider
schema:
  type: object
  required: [vaultPath, httpClient]
  properties:
    vaultPath:  { type: string }
    httpClient: { type: string, x-telo-ref: "std/http-client#Client" }
resources:
  - kind: Http.Request
    metadata: { name: "${{ self.name }}-read" }
    client: "${{ self.httpClient }}"
    inputs:
      url:    "https://vault/v1/secret/${{ self.vaultPath }}"
      method: GET
provide:
  kind: Http.Request
  name: "${{ self.name }}-read"
result:
  sessionId: "${{ result.body.data.session_id }}"
```

Consumed by `Mcp.HttpClient` via the same `x-telo-ref` slot any provider
satisfies (string-form reference per stdlib convention):

```yaml
kind: Mcp.HttpClient
metadata: { name: RegistryMcp }
url: http://registry.telo.localhost:8060/mcp
sessionProvider: RegistryVaultSession
```

## 4. Throws contract

`Mcp.ToolsCall` and `Mcp.ToolsList` declare a closed `throws` union so
`catches:` blocks and analyzer rule-9 coverage have something concrete:

| Code                          | When                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `ERR_MCP_TRANSPORT`           | Network failure, non-2xx HTTP response on the JSON-RPC POST, unexpected `Content-Type`. |
| `ERR_MCP_PROTOCOL`            | Malformed JSON-RPC envelope (missing `jsonrpc`, mismatched `id`, neither `result` nor `error`). |
| `ERR_MCP_JSON_RPC_ERROR`      | Server returned `{ "error": { code, message, data } }`. `data` includes the original numeric `code` (e.g. -32004 for the registry's `Module not found`). |
| `ERR_MCP_TOOL_ERROR`          | Server returned `{ "result": { isError: true, content: [...] } }` — spec's *soft* tool failure. Throw with `data.content` so handlers can inspect the LLM-readable message. |
| `ERR_MCP_SESSION_INVALID`     | **HTTP transport only.** Server rejected the session ID (HTTP 404/410, or JSON-RPC error indicating session expiry). In self-handshake mode (no `sessionProvider`) the client retries internally first; this code surfaces only when the internal re-handshake also fails. In external-provider mode the code surfaces on the first rejection — the workflow's `catches:` block owns the refresh policy. Unreachable for `Mcp.StdioClient` (the stdio connection itself is the session — there is no ID to invalidate; a dead session surfaces as `ERR_MCP_TRANSPORT` via child-process exit). |

The MCP spec distinguishes the protocol-level and tool-level error cases
deliberately (`ERR_MCP_JSON_RPC_ERROR` vs `ERR_MCP_TOOL_ERROR`); Telo
surfaces both as `InvokeError`s with distinct codes so consumers can
`catches:` only the class they care about. `ERR_MCP_SESSION_INVALID` is
separate from `ERR_MCP_TRANSPORT` because user-supplied session IDs make
"session expired" a routine event worth its own retry policy, not a
network-failure conflation. The canonical refresh pattern is a workflow-level
`catches:` block that deletes the stale session, throws a retryable code,
and lets the workflow engine re-run from the top.

## 5. Implementation layout

```
modules/mcp-client/
├── README.md
├── telo.yaml                          # Library (namespace: std, name: mcp-client) +
│                                      # Mcp.Client abstract + Mcp.SessionProvider abstract +
│                                      # Mcp.HttpClient + Mcp.StdioClient + Mcp.ToolsCall + Mcp.ToolsList
├── docs/
│   ├── http-client.md
│   ├── stdio-client.md
│   ├── tools-call.md
│   ├── tools-list.md
│   └── session-providers.md           # explains the abstract; shows user-authored providers
├── plans/
│   └── mcp-client-initial-design.md   # this file
├── nodejs/
│   ├── package.json                   # name: @telorun/mcp-client, version: 0.1.0
│   ├── tsconfig.json / tsconfig.lib.json
│   └── src/
│       ├── http-client-controller.ts   # Mcp.HttpClient (Telo.Invocable) — owns the self-handshake state machine, the session cache, sessionProvider delegation, and SSE/JSON parsing; invoke({method, params}) returns the JSON-RPC result
│       ├── stdio-client-controller.ts  # Mcp.StdioClient (Telo.Invocable) — owns child-process spawn/teardown, stdin/stdout framing, request-id correlation; invoke({method, params}) returns the JSON-RPC result
│       ├── tools-call-controller.ts    # Mcp.ToolsCall  (Telo.Invocable) — delegates to client.invoke({method:"tools/call",...}), converts isError into ERR_MCP_TOOL_ERROR
│       ├── tools-list-controller.ts    # Mcp.ToolsList  (Telo.Invocable) — delegates to client.invoke({method:"tools/list"})
│       ├── jsonrpc.ts                  # transport-agnostic request/response framing + id correlation; shared by both client controllers
│       └── errors.ts                   # InvokeError factories per §4
└── tests/
    ├── tools-call-http-self-handshake.yaml    # Mcp.HttpClient, no sessionProvider — client owns the session lifecycle
    ├── tools-call-http-user-provider.yaml     # Mcp.HttpClient + user-authored Mcp.SessionProvider template in the same test file
    ├── tools-call-stdio.yaml                  # Mcp.StdioClient against an in-fixture stdio MCP server (Node script under __fixtures__)
    ├── tools-call-errors.yaml                 # each ERR_MCP_* code via catches: (covers HTTP + stdio failure modes)
    └── __fixtures__/
        ├── stdio-server.mjs                   # minimal stdio MCP server used by tools-call-stdio.yaml; lives under __fixtures__ so kernel test discovery skips it
        └── static-analysis-negative.yaml      # consumed by analyzer/nodejs/tests/mcp-client-output-typing.test.ts; lives under __fixtures__ so kernel test discovery skips it (CLAUDE.md test-fixture convention)
```

### Transport implementation

Mixed strategy, chosen per-transport based on lifecycle compatibility with
the host kernel:

- **`Mcp.StdioClient`** uses `@modelcontextprotocol/sdk`'s `Client` +
  `StdioClientTransport`. The child-process lifecycle is owned end-to-end by
  the SDK; nothing in the kernel competes for the stdin/stdout pipes.
- **`Mcp.HttpClient`** is hand-rolled on top of `fetch`, sharing
  `jsonrpc.ts` for request framing. The SDK's
  `StreamableHTTPClientTransport` was not viable here: on
  `notifications/initialized` it opens a server-pushed SSE GET stream that
  stays alive until the client calls `transport.close()`. When the
  HttpClient sits alongside an `Http.Server` (every test, every realistic
  deployment) the SSE GET stream deadlocks Fastify's `server.close()` during
  teardown — `app.close()` waits for in-flight responses to drain, but the
  SSE stream only closes once `Mcp.HttpClient.teardown()` runs, and that
  doesn't run until the surrounding `with:` scope tears down. v1 has no use
  for server→client notifications (explicit non-goal in §2), so the simpler
  hand-rolled path that opens one fetch per RPC is the right call.

Both controllers share `jsonrpc.ts`'s monotonic `createIdAllocator()` and
the Streamable-HTTP envelope parser (`application/json` vs
`text/event-stream` data lines, JSON-RPC error → `ERR_MCP_*` mapping). A
third HTTP-family transport drops in via the same helper; a different
underlying-protocol transport plugs in alongside the SDK path the stdio
client already uses.

### Co-shipped: tighten `Http.Request.outputType`

This plan also touches one file outside `modules/mcp-client/`:
[`modules/http-client/telo.yaml`](../../../modules/http-client/telo.yaml).
`Http.Request` today declares only `schema.inputs` and leaves `outputType`
undeclared, which collapses the CEL type of `${{ result.* }}` against any
`Http.Request` step to `map<string, dyn>`. The §3.6 Vault example reads
`${{ result.body.data.session_id }}` and the rest of this plan's static-
typing headline depends on that access being chain-validated. Add
`outputType:` declaring the canonical Telo Response Object that the
runtime already returns (per the contract documented in
[`modules/http-client/README.md` §2](../../../modules/http-client/README.md)
and confirmed in [`http-request-controller.ts:7-10`](../../../modules/http-client/nodejs/src/http-request-controller.ts#L7-L10)):

```yaml
# Added to the existing Telo.Definition for Http.Request in
# modules/http-client/telo.yaml — sits alongside schema.inputs.
outputType:
  type: object
  additionalProperties: false
  required: [status, headers, body]
  properties:
    status:
      type: integer
      description: HTTP response status code.
    headers:
      type: object
      additionalProperties: { type: string }
      description: Response headers, normalized to lowercase keys (per §2 of the Response Contract).
    body:
      description: |
        Parsed JSON when content-type is application/json (or null on empty body
        with JSON content-type); raw string otherwise. Open shape — per-call
        narrowing is the manifest author's concern (use CEL or downstream
        Type kinds).
```

Notes:

- **Pure schema-declaration change.** The http-request controller already
  returns exactly this shape at runtime — no controller code changes, no
  behavioural deltas, no test changes inside `modules/http-client/`.
- **`body` stays open** (`additionalProperties: true` implied by no
  `additionalProperties` constraint on the object branch — actually here
  schema-less, since `body` can be `null` / string / object depending on
  content type). This is honest: a generic HTTP client cannot know the
  per-endpoint body shape statically. Consumers who need typed body access
  layer their own `Type.JsonSchema` narrowing on top — the analyzer already
  supports this via standard CEL chain access from a known parent shape.
- **Open `body` is fine for the Vault example** because the access pattern
  is `result.body.data.session_id` — `body` typed as `dyn` is enough for
  the chain to continue past it, and the `data.session_id` portion is the
  intentional dyn surface where per-endpoint shape lives. What the
  tightening *does* catch: typos in `status` / `headers` / the literal
  property `body` itself, and access to non-existent top-level fields like
  `${{ result.bdoy.X }}` or `${{ result.statsus }}`.
- **Ships in the same PR as mcp-client.** The change is small enough that
  splitting it into its own PR adds review overhead without proportional
  benefit; bundle it under one diff with the mcp-client introduction.

Package version: `@telorun/http-client` patch bump (e.g. 0.2.3 → 0.2.4) —
additive schema, no breaking surface.

## 6. Migration of existing test scripts

Two manifests stop hand-rolling MCP and consume the new kinds:

- [`modules/mcp-server/tests/http-tool-call.yaml`](../../../modules/mcp-server/tests/http-tool-call.yaml) —
  delete the `JS.Script McpFetch` block; replace `steps.CallGetWeather` with
  an `Mcp.ToolsCall` invoke against an `Mcp.HttpClient` provider. The fixture
  server is stateless, so `sessionProvider` is omitted entirely (no header
  echoed). Assertions tighten to read `result.content[0].text` directly.
- [`apps/registry/tests/e2e/mcp-tools.yaml`](../../../apps/registry/tests/e2e/mcp-tools.yaml) —
  same swap.

The bug class is structurally eliminated, not merely made unlikely. Today's
`JS.Script McpFetch` returns `{ status, hasError: true, result: {} }` on
any error response, so callers read `result.content[0].text` against an
empty success envelope — `result.content` is `undefined`, and the permissive
`additionalProperties: true` schema gives CEL a `dyn` typed access that
crashes only at runtime. After migration the success `outputType` has
`content` required and discriminated; an error response throws
`ERR_MCP_JSON_RPC_ERROR` / `ERR_MCP_TOOL_ERROR` and never produces a value
at all. "Empty success" is unrepresentable, so the CEL access has nothing
absent to read.

Both migrations shrink the manifest substantially — every line of inline
JavaScript disappears.

## 7. Documentation

Mandatory per CLAUDE.md:

- `modules/mcp-client/README.md` — module overview, kind table, a minimal
  Streamable HTTP example using the client's self-handshake mode (no
  `sessionProvider`), plus a minimal stdio example.
- `modules/mcp-client/docs/http-client.md`,
  `modules/mcp-client/docs/stdio-client.md`,
  `modules/mcp-client/docs/tools-call.md`,
  `modules/mcp-client/docs/tools-list.md` — one page per kind.
- `modules/mcp-client/docs/session-providers.md` — explains the
  `Mcp.SessionProvider` abstract (HTTP-only consumption), describes the
  HttpClient's self-handshake mode for users who don't need external
  session sources, and shows how to author a template-based provider that
  `extends: Mcp.SessionProvider` (the Vault example from §3.6).
- `pages/docusaurus.config.ts` `include:` array — add all six paths
  (README + five docs files).
- `pages/sidebars.ts` — add a `modules/mcp-client` group with the five
  kind/topic pages.
- Each markdown file under `docs/` gets `sidebar_label` frontmatter.

## 8. Changeset

Two files under `.changeset/`, both shipping in the same PR:

- `@telorun/mcp-client: minor` (new package, 0.1.0).
- `@telorun/http-client: patch` (additive `Http.Request.outputType`
  declaration, per the §5 "Co-shipped" sub-section — no behavioural
  change, only added static guarantees).

The kernel/analyzer/SDK changesets ship with their respective prerequisite
plans, separately.

## 9. Testing strategy

- `modules/mcp-client/tests/tools-call-http-self-handshake.yaml` — boots
  an `Http.Server` with a stateful `Mcp.HttpEndpoint` mount (in-process
  fixture, issues `Mcp-Session-Id` on initialize). Drives `Mcp.ToolsCall`
  with **no** `sessionProvider:` on `Mcp.HttpClient`. Asserts that the
  client transparently handshakes on first call and reuses the session on
  a second call. A third call follows server-forced session invalidation;
  assert the client transparently re-handshakes and the request still
  succeeds.
- `modules/mcp-client/tests/tools-call-http-user-provider.yaml` —
  declares a small in-file `Telo.Definition` that `extends:
  Mcp.SessionProvider`, threads it through `Mcp.HttpClient.sessionProvider`.
  Provider returns a constant `sessionId` (composed from existing kinds,
  no TypeScript controller). Asserts the supplied session ID is echoed on
  the wire and the client never runs its own handshake.
- `modules/mcp-client/tests/tools-call-stdio.yaml` — declares an
  `Mcp.StdioClient` pointing at `node`, with `args:
  [./__fixtures__/stdio-server.mjs]`. The fixture is a minimal MCP server
  that speaks the stdio transport (handshake + a single `echo` tool).
  Drives `Mcp.ToolsCall` against it; asserts the child process is spawned
  at boot, the handshake completes before `init()` returns, the tool call
  succeeds, and the process is terminated cleanly on teardown. Same
  ToolsCall manifest shape as the HTTP tests — proves the consumer is
  transport-agnostic.
- `modules/mcp-client/tests/tools-call-errors.yaml` — fixture endpoints
  (both HTTP and stdio variants) intentionally return / emit each error
  shape; assert each `ERR_MCP_*` code surfaces via `catches:`. Covers
  `ERR_MCP_SESSION_INVALID` against HTTP only — both self-handshake mode
  (after exhausted internal retry) and external-provider mode (first
  rejection). Covers `ERR_MCP_TRANSPORT` against stdio via a fixture that
  exits mid-call.
- `analyzer/nodejs/tests/mcp-client-output-typing.test.ts` — a TS unit
  test that loads the fixture at
  `modules/mcp-client/tests/__fixtures__/static-analysis-negative.yaml`
  through the analyzer API and asserts the expected diagnostic codes.
  Lives in the analyzer test suite (not in kernel `tests/`) because the
  manifest is intentionally rejected by `telo check`; routing it through
  the kernel test runner would either fail the suite or silently green
  depending on how rejection surfaces. The fixture covers:
  - Positive: `${{ steps.call.result.content[0].text }}` against a
    content item validates.
  - Negative (v1): `${{ steps.call.result.nonExistentField }}` against
    `Mcp.ToolsCall`'s closed `outputType` produces `CEL_UNKNOWN_FIELD` —
    this is the rejection class the whole module exists to enforce.
  - Negative (v1): `${{ steps.list.result.content }}` against
    `Mcp.ToolsList`'s output (which has no `content` property, only
    `tools`) produces `CEL_UNKNOWN_FIELD`.
  - Deferred: `${{ steps.call.result.content[0].data }}` against a
    `type: text` variant is currently *accepted* (cross-variant access
    isn't narrowed by the `type` discriminator yet, per §3.4). The test
    asserts the current behavior and is annotated with a `TODO` linking
    to the discriminator-narrowing follow-up; once that lands the
    expectation flips to `CEL_UNKNOWN_FIELD` and the TODO is removed.

## 10. Dependency on prerequisite plans

mcp-client cannot land until both prerequisites ship, in order:

**Analyzer prerequisite** ([template-internal-cel-validation.md](../../../analyzer/nodejs/plans/template-internal-cel-validation.md)):
- `Telo.Definition` resources are no longer skipped by the analyzer.
- `self` is registered as a typed CEL variable derived from each
  definition's `schema:`.
- `x-telo-context-from` supports `../`-prefixed parent-reference paths.
- Template internals (`resources:`, `invoke:`, `run:`) gain full
  type-checking against `self` plus kernel globals.

**Kernel prerequisite** ([provider-provide-template.md](../../../kernel/nodejs/plans/provider-provide-template.md)):
- `Telo.Provider` capability requires `provide()` method.
- `Telo.Definition` gains the `provide:` template target.
- `createTemplateController` synthesizes `provide()` implementations.
- Analyzer recognizes `provide.kind` / `provide.name` as reference targets
  and enforces `Telo.Provider` + `extends:` contracts on templates.

mcp-client itself no longer needs `provide:` for `Mcp.Client` (since the
abstract is over `Telo.Invocable` now — §3.1), but the
`Mcp.SessionProvider` abstract still depends on it for user-authored
template providers.

The analyzer plan merges first; the kernel plan follows; mcp-client lands
in a third PR. The in-scope `Http.Request.outputType` tightening (§5)
ships as part of that third PR — it's tiny and has no ordering dependency
on either prereq.

**Version pinning.** `@telorun/mcp-client@0.2.0`'s `package.json`
declares the following peer dependencies, populated with the actual semver
each prereq publishes (the gates are named here so the changeset that
ships mcp-client cannot land before the prereqs do):

- `@telorun/analyzer` — pinned to the **minor** that introduces
  template-internal CEL validation (the release shipped by
  [template-internal-cel-validation.md §6](../../../analyzer/nodejs/plans/template-internal-cel-validation.md)).
  Earlier analyzers don't walk `Telo.Definition` bodies, so user-authored
  `Mcp.SessionProvider` templates would silently regress to runtime-only
  failures — exactly the bug class this plan exists to close.
- `@telorun/kernel` — pinned to the **minor** that introduces the
  `provide:` template target and the `Telo.Provider`-requires-`provide()`
  contract change (the release shipped by
  [provider-provide-template.md §10](../../../kernel/nodejs/plans/provider-provide-template.md)).
  Earlier kernels can't satisfy template-defined `Mcp.SessionProvider`
  implementations.
- `@telorun/sdk` — pinned to the matching minor (provider-provide-template
  widens the `ProviderInstance` type).

The CHANGELOG and changeset description for `@telorun/mcp-client@0.2.0`
restate both prereq versions explicitly, so a future bisect lands on
known-good {kernel, analyzer} pairs. `@telorun/http-client`'s patch bump
ships in the same release train; no peer pin is needed because the
tightening is schema-only (additive — older mcp-client versions would
simply not benefit from it, not break against it).
