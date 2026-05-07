# MCP Server Module — Initial Design

This document maps out what the `mcp-server` module looks like, modeled on
`http-server`. Architectural shape is settled and ready for implementation.

## 1. What MCP gives us to expose

The Model Context Protocol is JSON-RPC 2.0 over a transport, with three primary
server-side primitives plus a few session features:

| Primitive       | Server obligation                                                         | Closest HTTP analogue      |
| --------------- | ------------------------------------------------------------------------- | -------------------------- |
| `tools`         | List + call. Each call: `{ name, arguments }` → content blocks.           | POST /tools/{name}         |
| `resources`     | List + read. Each read: `{ uri }` → contents (text/blob).                 | GET /resources?uri=…       |
| `prompts`       | List + get. Each get: `{ name, arguments }` → message array.              | GET /prompts/{name}        |
| `notifications` | Server → client async messages (progress, log, resource-updated, …).     | SSE event push             |
| `sampling`      | Server → client LLM-call request (server asks client to run a model).     | (no HTTP analogue)         |
| `roots`         | Client tells server which filesystem roots are in scope.                  | (request-context input)    |

**Transports:**

- **stdio** — process spawned by a desktop client (Claude Desktop, Cursor, etc.). One client per process.
- **Streamable HTTP** — single endpoint, server-sent events for streaming, multiple clients.
- **SSE** (legacy) — older two-endpoint variant; spec deprecated but still in the wild.

The `tools` surface is by far the most-used today; `resources` and `prompts`
are next; `sampling`/`roots` are advanced and likely v2.

## 2. Mapping to Telo capabilities

The HTTP module shape is the baseline for routing-style modules:

```
Http.Server (Telo.Service)        ←  listens, owns transport
  └─ mounts: [Http.Api, …]         ←  Telo.Mount, declares routes
       └─ routes[].handler         ←  Telo.Invocable (the user's logic)
```

MCP splits into **transport kinds** (stdio vs HTTP — different deployment
models, child process vs daemon, never sensibly mixed in one resource) and
**surface bundle kinds** (passive declarations of tools / resources /
prompts that compose by reference):

```
Mcp.StdioServer (Telo.Service)    ←  owns the stdio listener loop
  ├─ tools:     [→ Mcp.Tools, …]   ←  array of x-telo-ref: Mcp.Tools
  ├─ resources: [→ Mcp.Resources, …]
  └─ prompts:   [→ Mcp.Prompts, …]

Mcp.HttpEndpoint (Telo.Mount)     ←  mountable on Http.Server, exposes MCP at a path
  ├─ tools:     [→ Mcp.Tools, …]
  ├─ resources: [→ Mcp.Resources, …]
  └─ prompts:   [→ Mcp.Prompts, …]

Mcp.Tools     (Telo.Type)         ←  entries: [{ name, description, argumentsSchema, handler, inputs, result, catches }, …]
Mcp.Resources (Telo.Type)         ←  entries: [{ uri / uriTemplate, name, mimeType, handler, inputs, result, catches }, …] (v2 runtime)
Mcp.Prompts   (Telo.Type)         ←  entries: [{ name, description, arguments, handler, inputs, result, catches }, …]      (v2 runtime)
```

Bundle kinds are the only place entries are written. The transport kinds carry
no inline entries — they are pure ref arrays. This is the same factoring
http-server uses (`Http.Server.mounts:` is refs to `Http.Api`, never inline
routes), and gives composition for free: a single bundle can be referenced
from both transports, and multiple bundles can be merged into one transport.

`Mcp.HttpEndpoint` mounting on `Http.Server` is what enables the common case
of "REST API and MCP endpoint sharing one port" — `Http.Server` sees it as
just another mount, alongside `Http.Api`.

### 2.1 Handlers are plain `Telo.Invocable`s

Each entry inside an `Mcp.Tools` / `Mcp.Resources` / `Mcp.Prompts` bundle
declares everything MCP needs to advertise the entry to clients (the
per-bundle "advertised-shape" field — see §3) plus `inputs:` / `result:` CEL
adapters that bridge between the MCP envelope and the handler's own
input/output types. The handler itself is any `Telo.Invocable` and stays
oblivious to MCP — no typed abstract, no `extends:` indirection.

The advertised-shape field per bundle kind:

| Bundle kind | Advertised-shape field | What clients see |
| --- | --- | --- |
| `Mcp.Tools` | `argumentsSchema:` (JSON Schema) | Shape of the tool's `arguments` object |
| `Mcp.Resources` | `uri:` / `uriTemplate:` | The URI (or RFC 6570 template) to read |
| `Mcp.Prompts` | `arguments:` (named-string list) | A flat list of prompt parameters |

`inputs:` translates the MCP request (validated against `argumentsSchema:` for
tools, parsed from URI for resources, etc.) into whatever shape the handler's
`inputType` expects. `result:` translates the handler's output into the MCP
response shape (`{ content: [...] }`, `{ contents: [...] }`, `{ messages: [...] }`).
Both are mandatory: there's no shortcut path that omits them, because the
handler's I/O types are the user's domain shapes, not MCP envelopes.

**Result envelope per bundle kind.** `result:` is the **full MCP response
shape**, not just the primary content array:

| Bundle kind | Required | Optional |
| --- | --- | --- |
| `Mcp.Tools` | `content: ContentBlock[]` | `isError?: boolean`, `structuredContent?: object`, `_meta?: object` |
| `Mcp.Resources` | `contents: (TextResourceContents \| BlobResourceContents)[]` | `_meta?: object` |
| `Mcp.Prompts` | `messages: PromptMessage[]` | `description?: string`, `_meta?: object` |

`isError` on `Mcp.Tools` deserves a note: it's the spec's way to signal a
*soft* tool failure where the client should see content describing what went
wrong, rather than receive a JSON-RPC error. It's distinct from `catches:`,
which maps thrown `InvokeError`s into JSON-RPC errors. Use `isError: true`
when the handler ran successfully but the *result* is a friendly explanation
of an upstream failure (e.g. a third-party API returned 404 and you want the
LLM to read that in natural language); use `catches:` when the handler
genuinely throws.

### 2.1.1 Composition and conflict handling

Each transport reads every bundle in its `tools:` / `resources:` / `prompts:`
array and registers all entries on the SDK Server at init. Conflicts:

- **Duplicate `name` across two `Mcp.Tools` bundles** referenced by the same
  transport → init throws with both bundle/resource locations. Same rule for
  `Mcp.Prompts.entries[].name` and `Mcp.Resources.entries[].uri` /
  `uriTemplate`.
- **Same bundle referenced twice in one array** → init throws (likely a
  manifest mistake; if intentional, the user can split the bundle).
- **Bundles referenced by stdio and HTTP transports in the same app** are
  fine — each transport owns its own SDK Server registrations and there's no
  shared runtime state.

The analyzer should catch the duplicate-name case at compile time too — see
§5.1 for the cross-bundle topology change required.

### 2.2 CEL request context

Each entry exposes the same three CEL scopes the HTTP module uses, sourced
from the live MCP request:

```typescript
// inputs: context — used to map MCP request → handler input
{
  request: {
    name: string,            // tool / resource / prompt identifier
    arguments: object,       // validated against the entry's argument schema
    meta: object,            // MCP _meta passthrough (progressToken, etc.)
    session: {               // current MCP session metadata
      id: string,            // Streamable HTTP: server-issued session ID. stdio: synthetic UUID minted at transport creation (stdio has no transport-level session).
      clientInfo: { name, version },
      capabilities: object,
    }
  }
}

// result: context — used to adapt handler output → MCP response
{ result: <handler output>, request: { name, arguments } }

// catches: context — used to map InvokeError throws → MCP error
{ error: { code, message, data? }, request: { name, arguments } }
```

`request.session` carries per-connection metadata that has no HTTP analogue but
is useful for MCP — clients negotiate capabilities at `initialize`, and tools
sometimes branch on what the peer can do (e.g. only emit `resource_link` blocks
if the client advertises `roots/list`). Cheap to expose; opt-in on the CEL
side; no runtime cost when unused.

### 2.3 Transport semantics

The two transports differ enough at the lifecycle layer that the controllers
can't share a single binding model. Both end up dispatching through the same
`registry.build(...)` factory, but each owns its own session story.

**stdio (`Mcp.StdioServer`).** One process, one client, one implicit session.
`init()` builds a single SDK `Server` from `registry.build(...)`. `run()` binds
that Server to a `StdioServerTransport`, mints a synthetic session UUID at
transport creation (so `request.session.id` is always defined for CEL), and
holds the kernel via `ctx.acquireHold()` until stdin EOF. `teardown()` closes
the transport and releases the hold.

**Streamable HTTP (`Mcp.HttpEndpoint`).** The MCP SDK's
`StreamableHTTPServerTransport` is per-session, and `Server.connect(transport)`
is 1:1, so the controller cannot reuse a single Server across clients. v1
approach: the controller owns a per-mount session map keyed by the
`Mcp-Session-Id` header.

- On a POST without a session ID **and** method `initialize`: mint a new
  session ID, build a fresh `Server` via `registry.build(...)`, build a
  `StreamableHTTPServerTransport`, connect them, store
  `{ server, transport }` in the session map, return the new ID via the
  `Mcp-Session-Id` response header.
- On a POST/GET/DELETE with a known session ID: route to that session's
  transport.
- On a request with an unknown session ID: 404 (per spec).
- v1 has **no idle session GC** — sessions live until `teardown()`, which
  closes all transports. This is a known leak for long-running HTTP servers
  and is flagged in §6 as v2 work (idle expiry / max-sessions cap).

`registry.build(...)` is cheap (handler registration is just attaching dispatch
closures), so per-session rebuild is fine; no need for a "Server template +
clone" abstraction in v1.

## 3. Proposed package shape

```
modules/mcp-server/
├── telo.yaml                       # Telo.Library: 5 Telo.Definition
│                                   #   (StdioServer, HttpEndpoint, Tools, Resources, Prompts)
├── README.md                       # spec/overview
├── docs/
│   ├── stdio-server.md
│   ├── http-endpoint.md
│   ├── tools.md
│   ├── resources.md                # (v2 runtime)
│   └── prompts.md                  # (v2 runtime)
├── nodejs/
│   ├── package.json                # @telorun/mcp-server
│   ├── src/
│   │   ├── stdio-server-controller.ts  # Mcp.StdioServer (Telo.Service)
│   │   ├── http-endpoint-controller.ts # Mcp.HttpEndpoint (Telo.Mount on Http.Server)
│   │   ├── tools-controller.ts         # Mcp.Tools (Telo.Type — passive snapshot)
│   │   ├── resources-controller.ts     # Mcp.Resources (Telo.Type, v2 runtime)
│   │   ├── prompts-controller.ts       # Mcp.Prompts (Telo.Type, v2 runtime)
│   │   ├── registry.ts                 # given resolved bundles + serverInfo, builds SDK Server (shared)
│   │   └── outcome.ts                  # result/catches dispatch (shared)
│   └── tsconfig.lib.json
└── tests/
    ├── stdio-tool-call.yaml
    ├── stdio-tool-error.yaml
    ├── http-tool-call.yaml             # mounts Mcp.HttpEndpoint on Http.Server
    ├── tools-merge.yaml                # two Mcp.Tools bundles referenced by one transport
    ├── tools-shared-stdio-and-http.yaml # one Mcp.Tools bundle, two transports
    └── __fixtures__/
```

Telo.Definition entries:

- `Mcp.StdioServer` — capability `Telo.Service`. Fields: `serverInfo`, `tools: [Mcp.Tools]`, `resources: [Mcp.Resources]`, `prompts: [Mcp.Prompts]`. Owns the stdio listener loop; at init, resolves every ref in its three arrays, validates uniqueness across them (§2.1.1), and registers all entries on a single SDK `Server` bound to a `StdioServerTransport`.
- `Mcp.HttpEndpoint` — capability `Telo.Mount` (mountable on `Http.Server`). Same three array fields plus `serverInfo`. When registered into Fastify by `Http.Server`'s mount loop, owns the per-session map described in §2.3; each new session builds a fresh SDK Server from the resolved bundles.
- `Mcp.Tools` — capability `Telo.Type`. Field: `entries: [{ name, description, argumentsSchema, handler, inputs, result, catches }, …]` — **v1 runtime**. Snapshot exposes `{ entries }` so the analyzer and consuming transports can introspect.
- `Mcp.Resources` — capability `Telo.Type`. Field: `entries: [{ uri / uriTemplate, name, mimeType, handler, inputs, result, catches }, …]` — schema'd in v1, runtime in **v2**.
- `Mcp.Prompts` — capability `Telo.Type`. Field: `entries: [{ name, description, arguments, handler, inputs, result, catches }, …]` — schema'd in v1, runtime in **v2**.

The bundle kinds carry no shared `$defs` indirection — each kind owns its own
`entries[]` schema directly, because the per-entry shapes legitimately differ
(`argumentsSchema` vs `uri/uriTemplate` vs `arguments`). The fields that *are*
shared across all three (`handler`, `inputs`, `result`, `catches`) can be
factored into a `$defs` block in the library's `telo.yaml` if it cuts noise,
but that's an internal authoring detail — not part of the public schema.

**Mount contract (duck-typed).** `Http.Server`'s mount loop currently casts each entry of `mounts:` to `HttpServerApi` and calls `register(app: FastifyInstance, prefix: string)` on it (see `http-server-controller.ts:190`). For v1, `Mcp.HttpEndpoint` exposes the **same method signature** so the cast succeeds — no changes to `Http.Server` are required. This is a temporary duck-typing arrangement, not a polymorphic mount protocol; introducing a real `Telo.Mount` dispatch protocol (so `Http.Server` does not need to know the concrete mount type) is tracked as out-of-scope work below.

## 4. Sample manifests

### 4.1 stdio MCP server (desktop-spawned child process)

```yaml
kind: Telo.Application
metadata: { name: my-stdio-mcp }
targets: [Server]
---
kind: Telo.Import
metadata: { name: Mcp }
source: ../modules/mcp-server
---
kind: Telo.Import
metadata: { name: JavaScript }
source: ../modules/javascript
---
kind: Mcp.StdioServer
metadata: { name: Server }
serverInfo:
  name: my-stdio-mcp
  version: 1.0.0
tools: [WeatherTools]                   # array of refs to Mcp.Tools bundles
# resources: [...]                      # v2: refs to Mcp.Resources
# prompts:   [...]                      # v2: refs to Mcp.Prompts
---
kind: Mcp.Tools
metadata: { name: WeatherTools }
entries:
  - name: get_weather
    description: Get current weather for a city.
    argumentsSchema:                    # advertised to clients via tools/list
      type: object
      properties:
        city: { type: string }
      required: [city]
    handler:                            # any Telo.Invocable; oblivious to MCP
      kind: JavaScript.Script
      name: GetWeatherImpl
    inputs:                             # MCP arguments → handler input
      city: "${{ request.arguments.city }}"
    result:                             # handler output → full MCP CallToolResult envelope
      content:
        - type: text
          text: "${{ result.summary }}"
      isError: "${{ result.upstreamFailed }}"   # optional: soft-error signal (see §2.1)
    catches:
      - code: not_found
        error:
          code: -32001
          message: "${{ error.message }}"
---
kind: JavaScript.Script
metadata: { name: GetWeatherImpl }
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      city: { type: string }
    required: [city]
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      summary:        { type: string }
      upstreamFailed: { type: boolean }
    required: [summary, upstreamFailed]
code: |
  function main({ city }) {
    if (city === "Atlantis") {
      return { summary: `No weather data for ${city}.`, upstreamFailed: true };
    }
    return { summary: `Sunny in ${city}`, upstreamFailed: false };
  }
```

The handler is a plain `JavaScript.Script` with its own domain shape
(`{ city }` in, `{ summary }` out). The entry's `argumentsSchema:` is what MCP
advertises to clients; `inputs:` and `result:` bridge between MCP's envelope
and the handler's domain types. Same pattern for `Mcp.Resources` (with `uri:`
/ `uriTemplate:` in place of `argumentsSchema:`) and `Mcp.Prompts` (with
`arguments:` named-string list).

### 4.2 HTTP MCP endpoint (port-shared with a REST API)

```yaml
kind: Telo.Application
metadata: { name: my-http-mcp }
targets: [Web]
---
kind: Telo.Import
metadata: { name: Http }
source: ../modules/http-server
---
kind: Telo.Import
metadata: { name: Mcp }
source: ../modules/mcp-server
---
kind: Http.Server
metadata: { name: Web }
port: 8080
mounts:
  - type: Http.Api
    path: /v1
    name: Rest                          # your existing REST surface
  - type: Mcp.HttpEndpoint
    path: /mcp                          # MCP available at http://host:8080/mcp
    name: McpHttp
---
kind: Mcp.HttpEndpoint
metadata: { name: McpHttp }
serverInfo:
  name: my-http-mcp
  version: 1.0.0
tools: [WeatherTools]
---
kind: Mcp.Tools
metadata: { name: WeatherTools }
entries: [ … ]                          # same shape as 4.1
```

Same bundle-and-ref shape as `Mcp.StdioServer`. The difference is wiring:
`Mcp.HttpEndpoint` is a `Telo.Mount` consumed by `Http.Server`, so it uses
Fastify's listener and shares the port with `Http.Api` mounts.

### 4.3 Merging multiple bundles into one transport

```yaml
kind: Mcp.StdioServer
metadata: { name: Server }
serverInfo: { name: my-mcp, version: 1.0.0 }
tools: [WeatherTools, DatabaseTools]    # both bundles' entries are advertised
---
kind: Mcp.Tools
metadata: { name: WeatherTools }
entries: [ … ]
---
kind: Mcp.Tools
metadata: { name: DatabaseTools }
entries: [ … ]
```

Order in the array is the registration order. Duplicate `name` across the two
bundles → init throws (§2.1.1), with both bundle locations reported.

### 4.4 Sharing one bundle between stdio and HTTP

```yaml
kind: Telo.Application
metadata: { name: my-mcp }
targets: [Stdio, Web]
---
kind: Telo.Import
metadata: { name: Mcp }
source: ../modules/mcp-server
---
kind: Telo.Import
metadata: { name: Http }
source: ../modules/http-server
---
kind: Mcp.StdioServer
metadata: { name: Stdio }
serverInfo: { name: my-mcp, version: 1.0.0 }
tools: [Api]                            # ← same ref
---
kind: Http.Server
metadata: { name: Web }
port: 8080
mounts:
  - { type: Mcp.HttpEndpoint, path: /mcp, name: McpHttp }
---
kind: Mcp.HttpEndpoint
metadata: { name: McpHttp }
serverInfo: { name: my-mcp, version: 1.0.0 }
tools: [Api]                            # ← same ref
---
kind: Mcp.Tools
metadata: { name: Api }
entries: [ … ]                          # declared once
```

Both transports register the same set of tools by referencing one `Mcp.Tools`
resource. No `Telo.Library`-of-handlers indirection, no per-app
re-declaration. If stdio and HTTP need different deployment models (stdio
spawned per-client, HTTP a long-running daemon), split into two
`Telo.Application` files and put `Mcp.Tools` in a `Telo.Library` they both
import — same composition pattern, just across module boundaries.

## 5. Analyzer surface

Topology lives on the **bundle kinds** now (`Mcp.Tools`, `Mcp.Resources`,
`Mcp.Prompts`). The transport kinds carry only ref arrays, which are plain
`x-telo-ref` lists.

On each bundle kind's `entries` field:

- the array itself: `x-telo-topology-role: entries`
- `name` (or `uri` / `uriTemplate` on `Mcp.Resources`): `x-telo-topology-role: matcher`
- `handler`: `x-telo-topology-role: handler` + `x-telo-ref: Telo.Invocable` (any Invocable accepted; the entry's CEL adapters bridge to MCP)
- `inputs`: `x-telo-eval: compile`, `x-telo-context` describing the request scope (§2.2)
- `result`: `x-telo-eval: compile`, `x-telo-context` with `{ result, request }`
- `catches`: `x-telo-outcome-list: catches` + `x-telo-catches-for: handler` (the sibling `x-telo-catches-for` is required by `validate-throws-coverage.ts`; without it the throws-coverage check silently no-ops)

On each transport kind's `tools` / `resources` / `prompts` array:

- `x-telo-ref` to the corresponding bundle kind (`Mcp.Tools` / `Mcp.Resources`
  / `Mcp.Prompts`). Standard ref-list validation handles existence, kind
  match, and graph wiring; no new annotation.

### 5.1 Required analyzer work

The previous draft assumed `entries` / `matcher` / `handler` topology roles
would "just work" because `Http.Api`'s telo.yaml already uses them. They do
not. `analyzer.ts` (`buildStepContextSchema`, ~lines 186–192) only recognizes
`branch`, `branch-list`, and `case-map` — the routing-style values are
currently no-op tags everywhere they appear. Shipping `mcp-server` therefore
requires the following analyzer changes (which `Http.Api` will inherit for
free):

1. **Recognize `entries` / `matcher` / `handler` in the topology validator.**
   For each `entries` array on a bundle kind, build per-item context such
   that:
   - the item identified by `matcher` is the dispatch key (used for
     duplicate-name detection within the bundle);
   - the field tagged `handler` is the `Telo.Invocable` reference whose
     `inputType` / `outputType` flows into sibling `inputs:` / `result:`
     CEL contexts.
2. **Cross-bundle dedup at the transport.** A transport kind references
   multiple bundles via `tools: [A, B, …]`. The analyzer must walk those
   refs and report duplicate `matcher` values **across the merged bundle
   set**, not just within one bundle. This is new: today's topology
   validators stop at the resource boundary. The check is symmetric for
   `resources` (matcher = `uri` / `uriTemplate`) and `prompts` (matcher =
   `name`). Express it generically — keyed off the `entries`/`matcher`
   topology roles plus a transport-level `x-telo-merges-entries: tools`
   (or similar) annotation that says "follow these refs, merge their
   entries arrays, run a uniqueness check on `matcher`."
3. **Wire `x-telo-context` for the inputs/result/catches CEL fields.** With
   `handler` known, the analyzer can derive the context schemas and run the
   existing CEL type-checker against `${{ request.* }}`, `${{ result.* }}`,
   `${{ error.* }}`. No new annotation needed — just plumb the topology
   knowledge into the existing CEL validator.
4. **Throws-coverage on per-item `catches`.** `validate-throws-coverage.ts`
   already keys off `x-telo-outcome-list: catches` + `x-telo-catches-for`;
   confirm it can resolve `handler` as a sibling field name when both live
   inside an array item (not at resource root). If not, extend it.

These are scoped, non-speculative changes. The analyzer is supposed to be
topology-driven (CLAUDE.md: "the analyzer and telo editor must never
hardcode knowledge about specific resource kinds"), so this is debt being
paid down, not a new abstraction. Item 2 is the only genuinely new
mechanism — the others land for free once the topology roles are wired up.

## 6. Out of scope for v1 (proposed)

- `Mcp.Resources` and `Mcp.Prompts` runtime dispatch (kinds and schemas land in v1, runtime lands in follow-ups). The transport array fields (`resources:`, `prompts:`) are already typed against these kinds in v1 so manifests are forward-compatible; they just won't actually serve anything until the controllers ship.
- Streaming tool content + progress notifications — MCP makes both optional (clients only see what the server advertises in `initialize`); a request/response-only server is fully compliant. Revisit when a real consumer needs progress tokens or partial content; will come back as a `Stream<ContentBlock>` field on the `Mcp.Tools` entry and/or a `notifies:` block per entry. **This will be a breaking schema change** to `Mcp.Tools.entries[]`: `result:` will need to become a CEL expression whose value can be either an object (current shape) or a `Stream<ContentBlock>` (new shape, marked with `x-telo-stream` per CLAUDE.md). v1 manifests will need to be migrated when v2 ships; we are explicitly accepting that cost rather than reserving a forward-compatible shape now (the right shape is unclear until a real streaming consumer exists).
- Streamable HTTP idle-session GC and max-sessions cap (see §2.3 — v1 leaks sessions until `teardown()`).
- Generic `Telo.Mount` dispatch protocol on `Http.Server`. v1 relies on duck-typing the `register(app, prefix)` signature; the proper fix is a polymorphic mount contract so `Http.Server` does not cast to a specific concrete type. Tracked separately because it touches `http-server`, not `mcp-server`.
- Server-initiated `sampling` (advanced; needs client-side capability)
- `roots` (client filesystem hints)
- OAuth/auth — v1 is unauthenticated stdio + unauthenticated HTTP. Auth for `Mcp.HttpEndpoint` becomes a concern of the host `Http.Server` (CORS, reverse-proxy auth, future Telo middleware kinds).

## 7. Open work items

Implementation is roughly:

1. Scaffold `modules/mcp-server/` with `telo.yaml`, `package.json`, and the five controller stubs (two transports + three bundles).
2. **Bundle controllers** (`tools-controller.ts`, `resources-controller.ts`, `prompts-controller.ts`) — `Telo.Type` snapshots that expose `{ entries }` to consumers. Within-bundle uniqueness check on `matcher` (name / uri) at init.
3. `registry.ts` (shared) — given `serverInfo` plus the resolved bundle snapshots from a transport's `tools[]` / `resources[]` / `prompts[]` arrays, merge their entries (cross-bundle uniqueness check, §2.1.1), build an SDK `Server` instance, register each entry as a handler, and dispatch each call to `ctx.invokeResolved`. The dispatch pattern follows the Fastify route closure in `http-api-controller.ts` (around lines 456–519); `http-server` does not currently expose a standalone registry layer, so this is a new abstraction shaped after that closure.
4. Wire `Mcp.StdioServer` controller — `init()` resolves all bundle refs and calls `registry.build(...)`; `run()` binds SDK Server to `StdioServerTransport`, acquires a hold via `ctx.acquireHold()`, exits on stdin EOF; `teardown()` releases the hold and closes the transport.
5. Wire `Mcp.HttpEndpoint` controller — exposes `register(app: FastifyInstance, prefix: string)` (same shape `Http.Server` already calls on `Http.Api` — see §3 mount contract). Inside, registers a Fastify route at `<prefix>` that consults the per-mount session map (§2.3): mints a fresh `Server` (via `registry.build(...)` against the resolved bundles) plus a `StreamableHttpServerTransport` on `initialize` POSTs without `Mcp-Session-Id`, routes by header otherwise, returns 404 on unknown IDs. `teardown()` closes every transport in the map.
6. Schema/topology annotations on all five definitions. **Depends on §5.1 analyzer work landing first** (or in the same PR series) — without it the topology roles, cross-bundle dedup, and per-item CEL contexts are no-ops.
7. Tests: stdio happy path; stdio error mapping; HTTP happy path (single session, mounted on `Http.Server`); HTTP session-routing (two sequential sessions, distinct `Mcp-Session-Id`); `tools-merge.yaml` (one transport referencing two `Mcp.Tools` bundles); `tools-shared-stdio-and-http.yaml` (one bundle, two transports).
8. Docs in `docs/`, wired into `pages/sidebars.ts` (mandatory per CLAUDE.md). `pages/docusaurus.config.ts` derives its `include` list from `sidebars.ts` via `collectDocIds`, so it does not need editing.
9. Changeset.
