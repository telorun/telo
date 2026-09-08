---
description: "HTTP route outcome mapping: returns and catches lists with per-MIME content maps, CEL when: conditions, Accept-header negotiation, and stream-mode encoders."
sidebar_label: returns & catches
---

# `returns:` and `catches:`

> Examples below assume the `http-server` module is imported with an `imports:` entry under alias `Http`. Kind references (`Http.Api`, `Http.Server`, …) follow that alias.

Every route in an `Http.Api` defines two outcome lists:

- `returns:` — rendering rules for values the handler resolved with.
- `catches:` — rendering rules for structured `InvokeError` throws from the handler.

Plain `Error` / `RuntimeError` throws (operational failures) skip `catches:` entirely and are handed to Fastify's default 5xx renderer. This keeps domain failures distinct from infrastructure failures.

## Per-entry shape

```yaml
returns:
  - status: <int>            # required
    when: <CEL>              # optional — entry is selected if truthy
    mode: buffer | stream    # optional, default buffer
    headers:                 # optional — entry-level; never includes Content-Type
      <Header-Name>: <CEL or string>
    content:                 # required when status carries a body; omit for 204/304
      <media-type>:
        # buffer-mode value fields:
        body: <CEL or object>
        schema: <JSON Schema>
        # stream-mode value field:
        encoder: <ref to a Codec.Encoder>
        # per-media-type header overrides (merge over entry-level; per-MIME wins):
        headers:
          <Header-Name>: <CEL or string>
```

### Single buffer response

```yaml
returns:
  - status: 200
    content:
      application/json:
        body: { message: "${{ result.greeting }}" }
        schema: { type: object, properties: { message: { type: string } } }
```

### Single stream response (NDJSON)

```yaml
returns:
  - status: 200
    mode: stream
    content:
      application/x-ndjson:
        encoder: { kind: Ndjson.Encoder }
```

### Negotiated stream response

```yaml
returns:
  - status: 200
    mode: stream
    content:
      application/x-ndjson:
        encoder: { kind: Ndjson.Encoder }
      text/event-stream:
        encoder: { kind: Sse.Encoder }
        headers: { Cache-Control: "no-cache" }
      text/plain; charset=utf-8:
        encoder: { kind: PlainText.Encoder }
```

The `Accept` header decides which key wins (see [Content negotiation](#content-negotiation) below).

### Empty response (204, 304)

```yaml
returns:
  - status: 204
    when: "${{ result == null }}"
    # no `content:` block — status only
```

### Catches entry

```yaml
catches:
  - when: "${{ error.code == 'UNAUTHORIZED' }}"
    status: 401
    content:
      application/json:
        body:
          error:
            code: "${{ error.code }}"
            message: "${{ error.message }}"
  - status: 500 # catch-all for any declared code not matched above
    content:
      application/json:
        body:
          error:
            code: "${{ error.code }}"
            message: "${{ error.message }}"
```

`catches:` are buffer-mode only — by the time a catch fires the response is committed pre-stream and there's no upstream iterable to feed an encoder.

**The key is any media type, and editors suggest the common ones.** The `content:` map declares its known keys as `propertyNames.examples` — `application/json`, `application/problem+json`, `text/plain`, `text/html`, `text/event-stream`, `application/octet-stream`, `application/xml`, `application/x-ndjson`, `text/csv` — so completion offers them without closing the set. Any other valid media type (a vendor type, a parameterised one) is accepted exactly as before; `examples` carries no validation.

## Content negotiation

When a `returns:` entry's `content:` map has multiple keys, the dispatcher picks one per RFC 9110 §12.5.1:

1. Filter `returns:` entries by `when:` (existing behaviour).
2. From the matched entry's `content:` map, filter keys by `Accept` header:
   - q-values respected; `q=0` excludes.
   - Wildcards (`text/*`, `*/*`) supported.
   - Highest q-value wins.
   - Tie-break: declaration order of keys in the `content:` map.
3. No key matches → `406 Not Acceptable`, body lists available media types.
4. No `Accept` header (or only `*/*`) → first key in declaration order.

**Single-key maps still negotiate.** If the only declared key is `application/json` and the client sends `Accept: image/png`, the response is `406 Not Acceptable` (RFC 9110 §15.5.7). This is a deliberate behaviour change vs. the legacy single-`body` shape, which always sent the response regardless of `Accept`. Authors who want to ignore `Accept` entirely can declare `*/*` as a key — but typically you want the matrix response.

**Parameter handling.** Accept entries and content keys are matched on the type/subtype only — anything after the first `;` (e.g. `charset=utf-8`, `q=0.9`) is ignored for matching purposes (q-values are still parsed for ranking). This means `Accept: text/plain; charset=ascii` matches `content: { 'text/plain; charset=utf-8': ... }` — Telo doesn't enforce parameter-level preferences. Authors who need stricter matching should declare distinct keys per parameter combination.

## Rules

- **CEL context.** `returns:` entries see `{ result, request }`. `catches:` entries see `{ error, request }`. Cross-channel references (`result.*` in `catches:`, `error.*` in `returns:`) are rejected by the analyzer.
- **Stream-mode `when:`.** `result.*` is unavailable in stream-mode `when:` — the handler result is an unconsumed `Stream<...>`; iterating it to evaluate the predicate would either fail or consume the stream before bytes flow to the response. Reference only `request.*`. Load-time validator rejects violations.
- **`Content-Type` is forbidden in `headers:`.** The matched `content[mime]` map key is the only Content-Type source. Declaring it again in `headers:` is rejected at load time (case-insensitive).
- **`body` and `encoder` are mutually exclusive.** A `content[mime]` value uses `body` (buffer mode) or `encoder` (stream mode), never both.
- **Matching.** Both lists are scanned top-to-bottom. The first entry whose `when:` evaluates truthy wins. The first entry with no `when:` is the list's catch-all; entries following it are unreachable and rejected by the analyzer.
- **`returns:` is required.** Every route must define at least one `returns:` entry. `catches:` is optional when the handler's declared throw union is empty, or when a scope list covers it.
- **Streams on `returns:` only.** `mode: stream` is forbidden on `catches:` entries.
- **Unmatched `InvokeError`.** When no `catches:` entry at any level matches and no catch-all is present, the server renders `500 application/json { error: { code, message, data } }`.

## Scope lists: the router and the server

Error rendering is usually a property of a whole API rather than of one route, so
`Http.Api` and `Http.Server` each accept a `catches:` list of their own. They form a ladder
with the route's:

**A route's entries are tried first, then its router's, then the server's, and a throw no
entry claims renders the built-in envelope.**

```yaml
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
# Applies to every mount, and to notFoundHandler.
catches:
  - when: !cel "error.code == 'UNAUTHORIZED'"
    status: 401
    content:
      application/json:
        body: { error: !cel "error.code" }
mounts:
  - mount: !ref ordersApi
---
kind: Http.Api
metadata: { name: ordersApi }
# Applies to every route of this router.
catches:
  - when: !cel "error.code == 'NOT_FOUND'"
    status: 404
    content:
      application/json:
        body: { error: !cel "error.code", path: !cel "request.path" }
routes:
  - request: { path: /orders/{id}, method: GET }
    handler: !ref getOrder
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    # This route alone renders NOT_FOUND differently. UNAUTHORIZED still comes
    # from the server.
    catches:
      - when: !cel "error.code == 'NOT_FOUND'"
        status: 404
        content:
          application/json:
            body: { error: not_found, id: !cel "request.params.id" }
```

- **Fall-through is per entry, not per list.** A route that declares one entry has not opted
  out of everything else its scopes render — only of the codes its own entries match.
- **A route catch-all is a deliberate full override.** An entry with no `when:` makes the
  router's and the server's lists unreachable for that route. The rule that entries after a
  catch-all are unreachable stops at the list boundary, so this is not a diagnostic.
- **`request` is typed by level.** A route entry sees `request.query` / `body` / `params`
  from that route's own `request.schema`. A router or server entry sees `path`, `method` and
  `ip` only — there is no single route to type the rest from, so reaching for
  `request.params.id` there is a `CEL_UNKNOWN_FIELD` error rather than a run-time unknown
  variable.
- **The server's list reaches every mount**, including an `Mcp.HttpEndpoint` or a
  third-party one, because an unclaimed throw leaves the mount rather than being rendered
  inside it. It also covers `notFoundHandler`, whose own entries are tried first.
- **Non-`InvokeError` failures are untouched.** A catch entry keys on `error.code`; a plain
  `Error` has none, so those still go to Fastify's default 5xx renderer.

### Coverage

`UNCOVERED_THROW_CODE` is asked **once per route**, over the route's entries plus every
scope enclosing it — so a route that declares no `catches:` under a router that renders
everything reports nothing. The same goes for the unbounded-union rule: one catch-all at the
server satisfies it for every mounted route.

Each list is still checked against its own denominator. A route's is its handler's declared
throw union; a scope list's is everything that resource drives — its routes' handlers, and,
for a server, those of every mount. So an entry naming a code nothing can throw is reported
at that entry's own path, wherever it is written.


## Stream-mode pipeline

When a `mode: stream` entry matches:

1. Resolve the encoder ref (post-Phase-5 it's a live `Codec.Encoder` instance).
2. Read the handler's `result.output` (must be a `Stream<...>` or `AsyncIterable`).
3. Call `encoder.invoke({ input: result.output })` — yields `{ output: Stream<Uint8Array> }`.
4. Pipe the encoder's `output` to `reply.raw` via Node's `pipeline()` (handles backpressure).

Cancellation propagates top-to-bottom: client disconnect → Fastify socket close → `pipeline()` aborts → `Readable.from(...)` calls `.return()` on the encoder iterable → encoder's `for await` exits → source's `.return()` is called → `model.stream()` cancels the upstream call.

## Mid-stream throws

If a `mode: stream` `returns:` entry matches, the response is committed (status + headers flushed) before the stream body begins. A throw after that point cannot trigger `catches:` — the chunked transfer is aborted and the socket closed. Authors who need catchable failure inside a streaming pipeline must validate upfront and throw before the stream starts.

The format-codec encoders embed *in-band* error frames at their own level: `Ndjson.Encoder` emits `{"type":"error","error":{"message":"..."}}` and ends; `Sse.Encoder` emits `event: error\ndata: ...\n\n` and ends; `PlainText.Encoder` and `Octet.Encoder` propagate the error and abort the transport.

Regardless of encoder, a mid-stream failure is logged server-side through the server's structured logger at `error` level with the error, route, status, and MIME — so a failure that can't reach `catches:` is never silent for the operator. It is also emitted as an `Http.Api.streamFailed` event for debug tooling.

## `notFoundHandler`

`Http.Server.notFoundHandler` accepts the same `returns:` and `catches:` split as a route handler — same `content:` map shape, same Accept-header negotiation, same stream-mode rules. The `invoke:` resource runs when Fastify can't match any mounted route; its return value flows through `returns:`, its `InvokeError` throws through `catches:`, and a throw its own entries decline falls through to the server's list like any other.
