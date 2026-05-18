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
   every `${{ self.X }}` reference inside mcp-client's bundled providers
   (and every user-written provider) is a runtime-only failure.
2. [`kernel/nodejs/plans/provider-provide-template.md`](../../../kernel/nodejs/plans/provider-provide-template.md) —
   tightens `Telo.Provider` to require `provide()` and adds the
   `provide:` template target. Builds on (1) for its analyzer changes.

mcp-client lands on top of both, inheriting end-to-end static type checking:
a typo in `Mcp.SqlSession`'s `provide.bindings:` is rejected by `telo check`
before the manifest ever runs.

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

- stdio transport. The two existing call sites are both Streamable HTTP; stdio
  is a v2 add-on once a real consumer needs it.
- `resources/read`, `prompts/get`, `sampling`, notifications, roots. v1 covers
  `tools/call` + `tools/list`. Other RPCs land when something actually calls
  them.
- Bidirectional/long-lived sessions exposed as a kernel-level abstraction
  (subscribed notifications, server→client sampling). v1 surfaces the session
  ID, nothing more.

## 3. Resource kinds (v1)

```
Mcp.SessionProvider (Telo.Abstract over Telo.Provider, provide() contract)
  ↑ extends ─────────────────────────────────────────────────────────────
    Mcp.StaticSession      (template)  ←  fixed sessionId, e.g. from secrets
    Mcp.SqlSession         (template)  ←  per-call SELECT against a Sql.Connection
    user-defined providers (template, any library)  ←  composed from existing kinds

Mcp.HttpClient   (Telo.Provider)   ←  base URL, headers, optional sessionProvider ref
  ↳ used by ─────────────────────────────────────────────────────────────
Mcp.Tools.Call   (Telo.Invocable)  ←  tools/call against a referenced client
Mcp.Tools.List   (Telo.Invocable)  ←  tools/list against a referenced client
```

### 3.1 `Mcp.HttpClient` (Telo.Provider)

Two modes, distinguished entirely by the presence of `sessionProvider`. Same
manifest shape; the lifecycle inside the controller branches.

```yaml
kind: Mcp.HttpClient
metadata: { name: RegistryMcp }
url: http://registry.telo.localhost:8060/mcp
headers:
  authorization: "Bearer ${{ resources.Env.token }}"
sessionProvider: { kind: Mcp.SqlSession, name: RegistrySession }   # optional
clientInfo: { name: telo-test, version: 1.0.0 }
protocolVersion: "2024-11-05"     # optional, default tracks the SDK
```

| `sessionProvider` | Session lifecycle | Re-handshake on invalid |
| --- | --- | --- |
| **absent** | Client lazy-handshakes on first `Mcp.Tools.Call`, caches the session ID internally, transparently re-handshakes if a call returns session-invalid. Mirrors how `Sql.Connection`'s pool transparently reconnects on dead sockets. | Yes, internal to the client. One retry; second failure throws `ERR_MCP_SESSION_INVALID`. |
| **present** | Client never handshakes. Each tools/call calls `sessionProvider.provide()`, uses the returned `sessionId` as the wire header. | No — provider sources its sessions externally (DB row, Vault, secret); the client can't refresh what it doesn't own. Consumer's `catches:` handles the refresh policy at workflow level. |

This is the same pattern `Sql.Connection` uses: the resource that owns the
network thing owns its lifecycle. An external provider gives you control
over *where* the session comes from but explicitly opts out of the client's
internal lifecycle management.

Methods:

- `init()` validates configuration; no network I/O at boot.
- `provide()` returns the configured MCP transport (typed handle for
  `Mcp.Tools.Call` / `Mcp.Tools.List` to post through). In self-handshake
  mode, the transport's internal state machine handles session caching and
  reconnect. In external-provider mode, the transport is stateless about
  sessions — every post fetches a fresh session ID from the provider first.
- `snapshot()` exposes `{ url, sessionProviderName, protocolVersion }`.
  **Does not** expose a session ID — neither internal-cache nor
  provider-fetched IDs leak to CEL.
- `teardown()` closes any internal session/handshake state.

`sessionProvider` is validated as `x-telo-ref: "std/mcp-client#SessionProvider"`,
so the analyzer enforces that the target extends the abstract.

### 3.2 `Mcp.Tools.Call` (Telo.Invocable)

The replacement for the hand-rolled `tools/call` block.

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
        type: object
        properties:
          type: { type: string, enum: [text, image, audio, resource_link, resource] }
          text: { type: string }
          # data, mimeType, resource sub-shapes per the MCP spec
        required: [type]
    isError:           { type: boolean }
    structuredContent: { type: object, additionalProperties: true }
  required: [content]
```

Inputs **do not** include `sessionId`. Session selection is entirely the
client's concern. This is the change that unlocks static analysis: every
value exposed to callers has a typed schema, and "where the session came
from" is not a per-invocation decision the manifest needs to express.

Controller flow (sketch — actual implementation lives in
`tools-call-controller.ts`):

```ts
async invoke(inputs: { name: string; arguments?: object }) {
  const transport = await this.client.provide();    // typed MCP transport handle
  const sessionId = this.client.sessionProvider
    ? (await this.client.sessionProvider.provide()).sessionId   // external lookup
    : undefined;                                                 // transport handles its own session
  return this.postToolsCall(transport, sessionId, inputs);
}
```

The transport's internal state machine handles self-handshake mode
(`sessionProvider` absent): it lazy-initializes the session on first call,
caches it, and transparently re-handshakes on session-invalid responses
before retrying. In external-provider mode, the transport is told to never
manage sessions; each call passes the provider-supplied ID verbatim and
a rejected session bubbles up as `ERR_MCP_SESSION_INVALID` for the workflow
layer to catch.

The only place that imports the `SessionProviderInstance` TypeScript type is
this controller — the rest of mcp-client (and every user-defined provider)
goes through manifest declarations.

### 3.3 `Mcp.Tools.List` (Telo.Invocable)

Same shape as `Mcp.Tools.Call` (uses the same `sessionProvider`-from-client
flow, same throws contract). `outputType` is the SDK's typed tools-list
response (array of `{ name, description?, inputSchema }`).

### 3.4 `Mcp.SessionProvider` (Telo.Abstract) + bundled concretes

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

Any resource extending this abstract — whether shipped by mcp-client or
written by a user in another library — implements `provide()` through the
template machinery added by the kernel prerequisite plan
([provider-provide-template.md](../../../kernel/nodejs/plans/provider-provide-template.md)).
**mcp-client's bundled providers and a user-written one are
indistinguishable to `Mcp.HttpClient`** — that's the design property that
keeps users unblocked.

**Bundled concretes** (all template-defined, all in
`modules/mcp-client/telo.yaml`, no TypeScript controllers):

`Mcp.StaticSession` — fixed value, e.g. from a secret.

```yaml
kind: Telo.Definition
metadata: { name: StaticSession }
capability: Telo.Provider
extends: Self.SessionProvider
schema:
  type: object
  required: [sessionId]
  properties:
    sessionId: { type: string }       # CEL-expandable
resources: []                          # no internal resources needed
provide:
  # Trivially returns the configured value; uses Run.Return (or equivalent
  # zero-op invocable) as the dispatch target. Final field choice depends
  # on whether modules/run has a Return kind or we add one — see §11.
  kind: Run.Return
  name: "${{ self.name }}-return"
  inputs:
    sessionId: "${{ self.sessionId }}"
```

`Mcp.SqlSession` — per-call SELECT against a `Sql.Connection`.

```yaml
kind: Telo.Definition
metadata: { name: SqlSession }
capability: Telo.Provider
extends: Self.SessionProvider
schema:
  type: object
  required: [connection, sql]
  properties:
    connection: { x-telo-ref: "std/sql#Connection" }
    sql:        { type: string }
    bindings:   { type: array, items: {} }
resources:
  - kind: Sql.Query
    metadata: { name: "${{ self.name }}-query" }
    connection: "${{ self.connection }}"
provide:
  kind: Sql.Query
  name: "${{ self.name }}-query"
  inputs:
    sql:      "${{ self.sql }}"
    bindings: "${{ self.bindings }}"
  result:
    sessionId: "${{ result.rows[0].session_id }}"
```

**No bundled handshake-session kind.** The client's self-handshake flow
(initialize + notifications/initialized + cache + re-handshake on
invalidation) lives inside `Mcp.HttpClient`'s controller, not as a separate
SessionProvider kind. Reason: the handshake lifecycle is owned by the
resource that observes session-invalid responses on the wire — same
factoring as `Sql.Connection` owning its own TCP reconnect logic. Carving
out `Mcp.HandshakeSession` as a separate provider would create an
inverted dependency where the client tells the provider its session was
rejected, which is awkward and unnecessary when the client can just handle
it itself. Users who want a stateful MCP session simply omit
`sessionProvider:` from their `Mcp.HttpClient` — the client takes over.

**User-defined providers** drop in identically. A Vault-backed provider in
some other library:

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
    httpClient: { x-telo-ref: "std/http-client#Client" }
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

— consumed exactly like a bundled provider:

```yaml
kind: Mcp.HttpClient
metadata: { name: RegistryMcp }
url: http://registry.telo.localhost:8060/mcp
sessionProvider: { kind: VaultSession, name: RegistryVaultSession }
```

## 4. Throws contract

`Mcp.Tools.Call` and `Mcp.Tools.List` declare a closed `throws` union so
`catches:` blocks and analyzer rule-9 coverage have something concrete:

| Code                          | When                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| `ERR_MCP_TRANSPORT`           | Network failure, non-2xx HTTP response on the JSON-RPC POST, unexpected `Content-Type`. |
| `ERR_MCP_PROTOCOL`            | Malformed JSON-RPC envelope (missing `jsonrpc`, mismatched `id`, neither `result` nor `error`). |
| `ERR_MCP_JSON_RPC_ERROR`      | Server returned `{ "error": { code, message, data } }`. `data` includes the original numeric `code` (e.g. -32004 for the registry's `Module not found`). |
| `ERR_MCP_TOOL_ERROR`          | Server returned `{ "result": { isError: true, content: [...] } }` — spec's *soft* tool failure. Throw with `data.content` so handlers can inspect the LLM-readable message. |
| `ERR_MCP_SESSION_INVALID`     | Server rejected the session ID (HTTP 404/410, or JSON-RPC error indicating session expiry). In self-handshake mode (no `sessionProvider`) the client retries internally first; this code surfaces only when the internal re-handshake also fails. In external-provider mode the code surfaces on the first rejection — the workflow's `catches:` block owns the refresh policy. |

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
├── telo.yaml                          # Library + Mcp.SessionProvider abstract +
│                                      # Mcp.HttpClient + Mcp.Tools.Call + Mcp.Tools.List
│                                      # + StaticSession / SqlSession templates
├── docs/
│   ├── http-client.md
│   ├── tools-call.md
│   ├── tools-list.md
│   └── session-providers.md           # explains the abstract + ships-with-templates
├── plans/
│   └── mcp-client-initial-design.md   # this file
├── nodejs/
│   ├── package.json                   # name: @telorun/mcp-client, version: 0.1.0
│   ├── tsconfig.json / tsconfig.lib.json
│   └── src/
│       ├── http-client-controller.ts   # Mcp.HttpClient (Telo.Provider) — owns the self-handshake state machine when no sessionProvider is supplied
│       ├── tools-call-controller.ts    # Mcp.Tools.Call  (Telo.Invocable)
│       ├── tools-list-controller.ts    # Mcp.Tools.List  (Telo.Invocable)
│       ├── session-provider.ts         # SessionProviderInstance TypeScript interface — imported only by tools-call-controller
│       ├── jsonrpc.ts                  # request/response framing, SSE parsing
│       └── errors.ts                   # InvokeError factories per §4
└── tests/
    ├── tools-call-self-handshake.yaml         # no sessionProvider — client owns the session lifecycle
    ├── tools-call-static-session.yaml         # Mcp.StaticSession
    ├── tools-call-sql-session.yaml            # Mcp.SqlSession against an in-process fixture
    ├── tools-call-errors.yaml                 # each ERR_MCP_* code via catches:
    └── tools-call-user-defined-provider.yaml  # extends-SessionProvider in a sibling library
```

### Transport implementation

Depend on `@modelcontextprotocol/sdk` (already a dep of `modules/mcp-server`)
and use its `Client` + `StreamableHTTPClientTransport`. Free spec compliance,
schema validation, session handling. Hand-rolling was only justified inside
`JS.Script` where npm resolution isn't available.

## 6. Migration of existing test scripts

Two manifests stop hand-rolling MCP and consume the new kinds:

- [`modules/mcp-server/tests/http-tool-call.yaml`](../../../modules/mcp-server/tests/http-tool-call.yaml) —
  delete the `JS.Script McpFetch` block; replace `steps.CallGetWeather` with
  an `Mcp.Tools.Call` invoke against an `Mcp.HttpClient` provider. The fixture
  server is stateless, so `sessionProvider` is omitted entirely (no header
  echoed). Assertions tighten to read `result.content[0].text` directly.
- [`apps/registry/tests/e2e/mcp-tools.yaml`](../../../apps/registry/tests/e2e/mcp-tools.yaml) —
  same swap. The PUT-then-MCP race remains a real concern, but the symptom
  changes from "CEL access into empty object" to a clean
  `ERR_MCP_JSON_RPC_ERROR` throw (code -32004), and the existing
  `probeReadable` step already gates on read visibility.

Both migrations shrink the manifest substantially — every line of inline
JavaScript disappears.

## 7. Documentation

Mandatory per CLAUDE.md:

- `modules/mcp-client/README.md` — module overview, kind table, a minimal
  Streamable HTTP example with `Mcp.StaticSession`.
- `modules/mcp-client/docs/http-client.md`, `docs/tools-call.md`,
  `docs/tools-list.md` — one page per kind.
- `modules/mcp-client/docs/session-providers.md` — explains the abstract,
  documents the two bundled concretes (`StaticSession`, `SqlSession`),
  describes the client's self-handshake mode for users who don't need
  external session sources, and shows how to author a custom template-based
  provider (Vault example from §3.4).
- `pages/docusaurus.config.ts` `include:` array — add all five paths.
- `pages/sidebars.ts` — add a `modules/mcp-client` group with the four
  kind/topic pages.
- Each markdown file under `docs/` gets `sidebar_label` frontmatter.

## 8. Changeset

One file under `.changeset/` declaring `@telorun/mcp-client: minor` (new
package, 0.1.0). The kernel/analyzer/SDK changesets ship with the
prerequisite plan.

## 9. Testing strategy

- `modules/mcp-client/tests/tools-call-self-handshake.yaml` — boots an
  `Http.Server` with a stateful `Mcp.HttpEndpoint` mount (in-process
  fixture, issues `Mcp-Session-Id` on initialize). Drives `Mcp.Tools.Call`
  with **no** `sessionProvider:` on `Mcp.HttpClient`. Asserts that the
  client transparently handshakes on first call and reuses the session on a
  second call. A third call follows server-forced session invalidation;
  assert the client transparently re-handshakes and the request still
  succeeds.
- `modules/mcp-client/tests/tools-call-static-session.yaml` — same fixture,
  but the test app declares an `Mcp.StaticSession` and threads it through
  `Mcp.HttpClient.sessionProvider`. Asserts the supplied session ID is
  echoed verbatim and the client never runs its own handshake.
- `modules/mcp-client/tests/tools-call-sql-session.yaml` — same fixture
  plus a SQLite `Sql.Connection` seeded with a single row in
  `mcp_sessions`. Drives through `Mcp.SqlSession`. Asserts the SQL query
  fired and the call succeeded.
- `modules/mcp-client/tests/tools-call-errors.yaml` — fixture endpoint
  intentionally returns each error shape; assert each `ERR_MCP_*` code
  surfaces via `catches:`. Covers `ERR_MCP_SESSION_INVALID` in both modes:
  self-handshake (after exhausted internal retry) and external-provider
  (first rejection).
- `modules/mcp-client/tests/tools-call-user-defined-provider.yaml` —
  declares a small `Telo.Library` with its own `extends: Mcp.SessionProvider`
  template (composed from `JS.Script` so it has no external deps), imports
  it into the test app, threads it through `Mcp.HttpClient.sessionProvider`.
  Proves user-defined providers work end-to-end.
- `modules/mcp-client/tests/static-analysis.yaml` — a negative test the
  analyzer rejects: a manifest that does
  `${{ steps.call.result.nonExistentField }}` against `Mcp.Tools.Call`'s
  closed `outputType`. Encodes the contract this whole module exists to
  enforce.

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
- Six standard-library provider controllers (`Http.Client`,
  `Sql.Connection`, `S3.Client`, `Workflow.Connection`,
  `Workflow-Temporal.Connection`, `Config.*`) ship `provide()` in the same
  release.

The analyzer plan merges first; the kernel plan follows; mcp-client lands
in a third PR that pins its `@telorun/kernel` / `@telorun/analyzer` peer
dependencies to the versions that introduced template-internal CEL
validation and the `provide:` template target respectively.

## 11. Open decisions

Two remaining decisions before implementation starts:

1. **`Mcp.StaticSession` dispatch target.** The template needs *some*
   invocable to dispatch through (the kernel's template controller requires
   a target). Three options:
   - **A.** Add a `Run.Return` (or `Run.Identity`) zero-op invocable to
     `modules/run` whose output is its input. Generic, reusable for any
     future "supply a constant" template. (Recommended.)
   - **B.** Add a special-case for `provide:` with no target — the template
     controller returns the top-level `result:` CEL evaluation directly. Saves
     a kind but introduces an asymmetry with `invoke:` / `run:`, which
     always have a target.
   - **C.** Ship `Mcp.StaticSession` as a TS controller. Trivial code (~10
     lines) but breaks the property that *every* bundled provider is also a
     template, which costs the "indistinguishable from user-written
     providers" guarantee.

2. **Kind naming under `Mcp.Tools.`** Today's draft uses `Mcp.Tools.Call` /
   `Mcp.Tools.List` to mirror `Mcp.Tools` from mcp-server and to leave room
   for `Mcp.Resources.Read` / `Mcp.Prompts.Get` later. A flat `Mcp.Call`
   with a `method:` discriminator field is also defensible and matches how
   the underlying JSON-RPC actually works. Pick before implementation begins
   — renaming after publish is the disruptive kind of change.
