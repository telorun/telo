# Catch lists that cover a scope

## Problem

**Error rendering is declared per route, and the rules are not per route.** One HTTP
console repeats an identical 18-line `catches:` entry **five times** in a single router,
differing only in `status` and `when` — the evidence comes from auditing a consumer repo of
three report applications over thirteen libraries. Nothing about the shape is specific to
that domain: any router whose handlers throw a common vocabulary (`NOT_FOUND`,
`UNAUTHORIZED`, `CONFLICT`) has to restate the rendering of each one on every route.

**Per-route is the outlier.** No mainstream HTTP framework makes error-to-response mapping
a per-route declarative list; two mechanisms dominate, and both exist to avoid restating
rules per route. **One handler per scope** — Fastify's `setErrorHandler` on the instance
(with a per-route `errorHandler` that overrides it; both verified in the version this
module ships against), Express's four-arity error middleware on an app or `Router`, Echo's
`HTTPErrorHandler`, Spring's `@ControllerAdvice`. Or **the mapping attached to the error
type** — Axum's `IntoResponse`, Actix's `ResponseError`, JAX-RS's `ExceptionMapper<E>`,
Spring's `@ResponseStatus`. Everything else is scope inheritance and specificity: a route
rule beats a router rule beats an app rule.

Telo has only the innermost rung. `Http.Server.notFoundHandler` looks like the outer end
and is not: it answers *no route matched*, never *a handler threw*. For errors there is one
level, and the duplication collects at the two that are missing.

**Two things are not true today and are load-bearing.**

- **An unmatched throw does not propagate.** `http-dispatch` renders a fixed 500
  `{error: {code, message, data}}` and returns, so nothing escapes a route into the server.
  A shared library deciding, silently, how an unhandled error renders is the error
  swallowing this repository forbids, and it is what makes any outer rung unreachable.
- **Nothing declares a `throws:` block in `http-server` or `mcp-server`.** A denominator
  computed from what these kinds declare is not loose — it is *empty*, which reports every
  entry of a new scope-level list as naming a code nothing can throw.

## Solution

### 1. Three rungs, one precedence sentence

`Http.Api` and `Http.Server` each accept a `catches:` list, anchored — like
`Server.notFoundHandler.catches` already is, and unlike the route list, which carries a
fourth inline copy of the same shape — at `HttpDispatch.Outcomes/$defs/Catches`.

**A route's entries are tried first, then its router's, then the server's, and an
unmatched throw renders the built-in envelope.** That is Fastify's `errorHandler`-beats-
`setErrorHandler`, and it is what lets one route override the rendering of `NOT_FOUND`
without restating `UNAUTHORIZED`.

Crossing the mount boundary is a **rethrow**, not a wider mount contract. `dispatchCatches`
stops inventing a response and reports whether it matched; `Http.Api` rethrows what neither
its route nor its own list rendered; the server's error handler renders its `catches:` and,
on no match, the same envelope `http-dispatch` renders today. A server declaring no
`catches:` therefore produces byte-identical responses to today, and the fallback moves to
the resource that owns the transport rather than changing.

Three consequences fall out rather than being added: the rung applies to **every** mount
including third-party ones and `Mcp.HttpEndpoint`, whose escaping errors genuinely are the
HTTP server's to render; it applies to `notFoundHandler`, whose own list is tried first;
and non-`InvokeError` failures are untouched, because a catch entry keys on `error.code`
and a validation failure has none — those keep today's mapping and Fastify's default.

**Verify.** A router whose routes declare no `catches:` renders the same responses as the
five-copy version; a route entry wins over a router entry matching the same throw while the
router's other entries still apply to that route; a server entry renders a throw no route
or router matched; with no list at any level the response is byte-identical to today's
built-in envelope.

Release: `.changes/pending/`, `modules/http-server: Added`; `.changeset/`,
`"@telorun/http-dispatch": minor`.

### 2. `request` is typed by level

A route's catch context declares `request` with `path`, `method` and `ip`, and *then*
merges that route's own `request.schema` for `query` / `body` / `params`. A router- or
server-level entry gets the same three fields and no merge — there is no route to merge
from, and both rungs are reached with the request in hand and nothing route-specific known
about it.

```yaml
# server / router  request.path ✓   request.params.id ✗
# route            request.path ✓   request.params.id ✓
```

The rule already exists one level down; it is applied at two fewer levels, not extended. A
scope entry reaching for `params` is `CEL_UNKNOWN_FIELD` on its own line, needing no new
diagnostic code.

**Verify.** `request.path` in a router and in a server entry resolves; `request.params.<x>`
in either is reported; the same expression inside a route that declares those params
resolves.

### 3. One denominator rule, not three

A catch list's denominator is always *the throws union of the work the enclosing resource
drives*. So a route entry keeps its sibling `handler`; a router entry and a server entry
take **their own resource's** reach — the routes a router drives, the mounts a server
holds, transitively. Naming three rules — one per rung — would be two too many, and the
third would have to name a wildcard segment in a pointer vocabulary that is plain RFC 6901
everywhere it appears (`x-telo-ref`'s `inputs:`, the zone `key:` lists, `peers:`).

Two vocabulary changes carry it, both additive and both read through accessors that already
exist:

- **`x-telo-catches-for` takes the empty pointer**, naming the resource the list is written
  on beside today's sibling-field form — the spelling `x-telo-schema-projection-from`
  already uses for the same "this declaration, not one it references" meaning. That
  annotation IS the claim about the denominator, which is why it is not
  `throws: { inherit: true }`: `inherit` declares that a kind's union is the union of what
  it dispatches, and a kind that has not made that claim must not have it inferred — one
  holding a `call` ref it catches internally would silently gain codes it never lets
  escape. It is also forbidden on a `Telo.Service` and a `Telo.Mount`, rightly, because
  what a router *renders* is not what a router *throws*.
- **A holder slot declares that throws surface through it.** `mounts[].mount` is
  `use: dependency` (the server holds the mount and calls a convention method; control
  reaches the routes through the mount's own `trigger.inbound` slots), so the closure needs
  one hop the `use` vocabulary correctly refuses to describe. `x-telo-ref` gains
  `throwsThrough: true`, declared by the kind that **holds** — only a server knows a mount's
  throws surface through it — and it is the same fact the rethrow establishes, so the
  annotation and the runtime cannot disagree. Without it the closure either stops at the
  server or crosses every `dependency` edge and drags a connection's throws in.

`throwsThrough` does double duty, because it is one fact stated once: it is the edge the
throws closure crosses **and** the edge a catch scope encloses through.

Three edges, three answers. A **step body** contributes its own traversal, `try` / `catch`
subtraction included. A **control-transferring ref** contributes the target's own declared
union — a route handler is a leaf, and asking what it drives would credit the scope with
codes the handler catches internally. A **`throwsThrough` ref** recurses, because its
target is another scope on the same ladder.

### 4. Coverage moves to the route, over all three lists

Adding two lists changes the coverage **denominator**, and getting it wrong is not a
missing check but a false one: left per-list, every route that declares no `catches:`
reports as uncovered, firing on precisely the manifests this item exists to enable.

| Question | Where it is asked |
| --- | --- |
| a throw that nothing handles | per route, over the route's ++ its router's ++ the server's entries |
| an entry that nothing can throw | per list, against that list's own denominator |

So `UNCOVERED_THROW_CODE` and `UNBOUNDED_UNION_NEEDS_CATCHALL` are evaluated once per
route, anchored at the route, and satisfied by a matching entry or a catch-all at any of
the three levels. A scope list owes no coverage of its own; it contributes. Scope coverage
propagates down `throwsThrough` edges, so a server's entries answer for every mounted
router's routes.

`UNDECLARED_THROW_CODE`, `error.data` typing (`CEL_UNKNOWN_FIELD`) and `CATCHALL_NOT_LAST`
stay per list. The first two are bounded wherever the app's handlers declare bounded
throws — the closure is only unbounded when something it reaches is — so a scope entry
naming a code nothing mounted can throw is still reported at its own path, and
`error.data.<field>` is still typed against the intersection of the applicable codes.

One consequence is accepted deliberately rather than discovered later: **a server-level
catch-all makes `UNCOVERED_THROW_CODE` unfireable in that application.** That is truthful —
nothing is unhandled — and it is the trade every framework makes the moment a global
handler exists.

**Verify.** A route with no `catches:` under a router that covers everything reports
nothing; a router entry naming a code no mounted handler can throw is reported at the
router entry's own path; a code that only the server's list covers is not reported against
the route; a handler with an unbounded union under a router-level catch-all is not
reported; a route reaching `error.data.<typo>` under a bounded union is still reported.

Release: `.changeset/`, `"@telorun/analyzer": minor`.

### 5. No runtime floor — verified, not assumed

`http-server` writes both new annotation forms in its own manifest, so the mandatory
question is whether an older analyzer rejects it. **It does not:** the previously published
CLI reads the module with no issues, because both forms degrade to silence rather than to a
complaint — `x-telo-catches-for: ""` is falsy, so that analyzer skips the list entirely,
and `throwsThrough` is an unknown key inside an `x-telo-ref`, which nothing rejects. The
`catches:` property itself lives in each kind's own schema, which is open. So the module
keeps the `>=0.82.0` its returned-effect chains need, and adding a higher bound would be a
claim nothing can refute — the failure class the mechanism exists to remove.

What an older analyzer does instead is *under-check*: it skips a scope list's entries and
counts none of its coverage, so it reports `UNCOVERED_THROW_CODE` on routes a scope list
renders. That is a consumer-side reason for an **application** to declare
`requires: telo: ">=<the release that carries it>"`, and the release notes say so; it is
not a reason for this module to.

**Verify by execution.** Run the previous published CLI against
`modules/http-server/telo.yaml` and confirm it reports nothing — the evidence that no floor
belongs here.

## Decisions

- **A scope, not a named value.** The rejected alternative was a catch list declared once as
  a resource and referenced from each route's `catches:`. It is the one shape no framework
  uses, because naming a shared list at every route is still per-route boilerplate — just
  shorter — and it needs a container kind that does not exist, which would have to be
  invented per transport (an HTTP entry has `status`/`content`, a JSON-RPC one has
  `code`/`data`) or made untyped, and untyped is precisely what switches coverage off.
- **A route catch-all overriding its scopes is intentional, not a defect.** A no-`when:`
  entry in a route's list makes the router's and the server's entries unreachable *for that
  route*. The existing rule that entries after a catch-all are unreachable stops at the list
  boundary: extending it across levels would turn every deliberate full override into a
  diagnostic.
- **Outer entries run after inner ones, not before.** The reverse order would make the
  server's list a filter that no route could escape, so the only way to render one code
  differently would be to stop using the outer lists at all — which is the duplication this
  item removes, reintroduced as an all-or-nothing choice.
- **The mount contract does not widen.** Handing the server's list down to each mount would
  put HTTP outcome entries on a seam `Mcp.HttpEndpoint` implements, which could then only
  honour them by rendering an HTTP response where a JSON-RPC one belongs, or ignore them and
  make "applies to every mount" a lie. A rethrow needs nothing from any mount.
- **The `request` narrowing is stated, not inherited.** Leaving a scope entry's `request`
  open would be the easy reading and the wrong one: it types `request.params.id` as valid
  in a position where nothing can supply it, so the failure moves from `telo check` to a
  runtime `Unknown variable` — the exact trade this repository refuses elsewhere.
- **The error envelope stays a field, not a built-in shape.** The body is the app's
  contract with its own page; baking one in would make the common case easy and the
  uncommon one impossible — which is why this item moves *where* a catch entry is declared
  and changes nothing about what it renders.
- **This does not become a shared kind for every transport.** `mcp-server` declares its own
  copy of the outcome vocabulary and would need its own scope-level list; what is shared is
  the entry *shape*, through the existing carrier, and the two annotation forms above, which
  name no kind. A single kind spanning both would have to erase the per-transport entry type
  to fit.

## Complete example after the change

```yaml
kind: Http.Server
metadata:
  name: server
port: !cel "ports.http"

# Applies to every mount. Evaluated after a mount's own entries.
catches:
  - when: !cel "error.code == 'UNAUTHORIZED'"
    status: 401
    content:
      application/json:
        body: { error: !cel "error.code", message: !cel "error.message" }

mounts:
  - path: /v1
    mount: !ref ordersApi
---
kind: Http.Api
metadata:
  name: ordersApi

# Applies to every route of this router. Evaluated after a route's own entries.
catches:
  - when: !cel "error.code == 'NOT_FOUND'"
    status: 404
    content:
      application/json:
        body: { error: !cel "error.code", message: !cel "error.message", path: !cel "request.path" }

routes:
  - request: { path: /orders, method: GET }
    handler: !ref listOrders
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }

  - request: { path: /orders/{id}, method: GET }
    handler: !ref getOrder
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    # This route alone renders 404 differently. 401 still comes from the server.
    catches:
      - when: !cel "error.code == 'NOT_FOUND'"
        status: 404
        content:
          application/json:
            body: { error: not_found, id: !cel "request.params.id" }
```
