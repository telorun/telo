# URL Shortener — comprehensive example + new `cache` (+ `cache-memory` / `cache-redis`) and `rate-limit` modules

## Problem

The existing examples are thin demos. We want one realistic, deployable application that exercises Telo across many concerns at once — a public redirect service plus an admin/analytics API — and that, in the course of building it, fills the standard library's real gaps in cross-cutting concerns the architecture explicitly intends to cover but no current module provides: a **cache** primitive, a **rate-limit** primitive, generic **background execution** (`ctx.runDetached` + `Run.Detach`), and transport-derived **client IP** on `http-server`. Analytics are persisted in SQL and queried on demand — no separate metrics module.

## Solution

A URL shortener with two surfaces:

- **Public side** — `POST` to create a short code for a long URL; `GET /{code}` issues a `302` redirect (`Location` header) to the target and records a click. Hot-path lookups (`code → target`) go through the cache; the public endpoints are rate-limited per client.
- **Admin/analytics side** — list links, fetch a single link's stats (click counts, recent clicks). Analytics are **durable business data persisted in SQL**, queried on demand — not operational telemetry.

The app is a thin `Telo.Application` root that wires `std/*` imports plus two local `Telo.Library` directories:

- `examples/url-shortener/redirect/` — public create + redirect routes, cache read-through, rate-limit guard.
- `examples/url-shortener/admin/` — list/stats routes over SQL.

Persistence is SQLite by default (zero external setup) via `std/sql`, using `Sql.Migrations` for the `links` and `clicks` tables and `std/sql-repository` + `Sql.Query`/`Select` for reads and writes. Redirects, path params, and response headers are already supported by `std/http-server` `returns:` entries.

### New modules: `cache` + backends (`cache-memory` / `cache-redis`)

A backend-pluggable cache, split across modules the same way the codec family is (`codec` abstract + `plain-text-codec` / `ndjson-codec` / … implementations):

- **`modules/cache/`** — abstract only: the `Cache.Store` provider abstract plus the `Cache.Lookup` / `Cache.Entry` invocables and the `Cache.View` composite, all operating against any `Cache.Store`. No backend implementation.
- **`modules/cache-memory/`** — `CacheMemory.Store`, `extends` `Cache.Store`; in-process backend.
- **`modules/cache-redis/`** — `CacheRedis.Store`, `extends` `Cache.Store`; Redis backend.

**Freshness — fresh vs stale.** `Cache.Entry` carries two windows: `ttl` (fresh) and an optional `staleTtl` (grace window past `ttl`). `Cache.Lookup` returns a state enum, `{ state: "miss" | "fresh" | "stale", value, age }`, with `hit = state != "miss"` for callers that don't care. Freshness is one additive output field, not a second read resource — an author who ignores it just reads `result.value`.

**Read-through — `Cache.View`.** A higher-level invocable that takes a `store` plus a wrapped target dispatched through the standard `invoke:` field (a `!ref` to the source of truth, e.g. the SQL lookup) and encapsulates the whole pattern via a `revalidate` mode:

- `miss` → await the wrapped target, populate, return.
- `fresh` → return cached value immediately.
- `stale` → return cached value **immediately**, and (when `revalidate: background`) schedule a detached revalidation; `revalidate: sync` re-loads before returning; `off` treats stale as miss. A target error during revalidation keeps serving stale (stale-if-error), logged via the EventBus.

`Cache.View` is a **decorator**, following the established convention (see `plans/decorator-capability.md`): a decorator dispatches its wrapped target through the existing `invoke:` field, and additional decorator layers stack via an `inner` field that holds an **inline nested decorator definition only — never a `!ref`**. The leaf decorator omits `inner` and points `invoke:` at the terminal invocable. Here `Cache.View` is the leaf — it wraps the SQL lookup directly, so it sets `invoke: !ref LookupLink` and has no `inner`. No new capability or kernel dispatch is needed — Telo already expresses this. Callers invoke `!ref ResolveTarget` exactly as they would the bare target. It collapses the read path into one call and is reusable by any read-through consumer. Background revalidation is **single-flight per cache key** — N concurrent stale hits trigger one revalidation, not N (cache-stampede prevention); the dedup lives in `Cache.View`, keyed by cache key.

**SDK/kernel addition — `ctx.runDetached`, tasks owned per resource.** True stale-*while*-revalidate (serve stale, refresh without blocking) needs fire-and-forget execution. Two layers, with **zero manifest burden** — no pool resource, no `tasks:` ref:

- **`ctx.runDetached(fn)`** runs `fn` outside the caller's cancellation/trace scope (a task spawned mid-request must escape the request's ALS so request completion can't abort it — only the kernel owns that ALS handle). The per-resource `ResourceContext` that exposes it **tracks** the task and routes a failure to the EventBus (`background.task.error`) — a detached task has no caller to throw to.
- **Drained by the owning resource's teardown.** The kernel folds a bounded drain into each resource's `teardown()`: tearing a resource down awaits its in-flight detached tasks (up to a timeout, then abandon-with-logged-event). The kernel keeps no task registry — it just tears down resources, as always; a resource's background work is bounded by the resource's own lifetime. Ordering is correct for free: a resource tears down before its dependencies (reverse order), and its tasks only touch those dependencies, which are still alive while it drains.

`Cache.View revalidate: background` and `Run.Detach` both just call `ctx.runDetached` — nothing to wire.

`CacheRedis.Store` accepts an optional `fallback` ref to another `Cache.Store` (e.g. a `CacheMemory.Store`). When Redis is unreachable it **degrades to the fallback store**, emits a degraded-mode event on the kernel EventBus, logs it, and recovers automatically when Redis returns. The failover is a property of the abstract composition — reusable by any consumer — not bespoke to this app. Errors are surfaced, never swallowed.

### `http-server` addition: `request.ip` + `trustProxy`

The rate-limit key must be the **canonical client IP**, which is a transport concern — not something the manifest derives from a raw header. Reaching into `request.headers['x-forwarded-for']` is fragile: absent on direct connections (collapsing every such client into one bucket), a comma-separated list behind multiple proxies, and spoofable unless the trusted edge overwrites it. So `std/http-server` gains a derived `request.ip` in the handler CEL context, computed honoring a new `trustProxy` field on `Http.Server` (boolean / hop-count — backed by Fastify's existing `trustProxy` + `request.ip`). Manifests reference `${{ request.ip }}`; the trust boundary is declared once and stays statically analyzable. This is a small, generally useful addition independent of the example.

### New module: `rate-limit` (`modules/rate-limit/`)

A `RateLimit.Guard` invocable (sliding-window / token-bucket) whose counter store is a `Cache.Store` ref, so it composes directly with any cache backend. Its `key` is an **explicit string input** (fed `${{ request.ip }}` here, but equally an API key, user, or tenant) — the guard stays transport-neutral rather than baking in IP semantics. An empty/null key is handled **deliberately** (fail-closed reject, not a silent merge into one shared bucket). Used on the public create and redirect endpoints; on allow it passes through, on deny the route returns `429`.

When its store is a `CacheRedis.Store` that has failed over to memory, counters are no longer shared across instances and limits effectively loosen in a multi-instance deploy. This is an accepted availability-over-strictness trade, but it is made **observable**: the degraded state is logged and surfaced via the same EventBus event and a readiness signal — never a silent switch.

Each module (`cache`, `cache-memory`, `cache-redis`, `rate-limit`) ships its own `telo.yaml`; the backend modules and `rate-limit` ship Node controllers under `nodejs/src/`. The `Run.Detach` controller ships in `std/run`; `ctx.runDetached` + per-resource drain live in the SDK/kernel. All ship `docs/` (wired into Docusaurus per repo policy) and `tests/*.yaml`. Releases: changesets for the npm controller packages, changie fragments for the module manifests.

## Decisions

- **No `metrics` module — analytics live in SQL.** Click analytics are durable business data, queried on demand from the `clicks` table. Operational telemetry is left to the existing EventBus/tracing layer; no separate metrics primitive is built here.
- **Cache abstract and backends are separate modules (`cache` + `cache-memory` + `cache-redis`), mirroring the codec family.** The abstract carries the `Cache.Store` contract and the `Lookup`/`Entry` invocables; each backend `extends` it in its own module. Consistent with the established `codec`/`*-codec` pattern and "design for breadth"; rejected a single module bundling all backends (couples a Redis client dependency into every consumer that only needs memory).
- **Ship memory + Redis now (not memory-only).** The example defaults to `cache-memory` for zero-setup demo/test runs; the `cache-redis` path is real and documented.
- **Fresh/stale is an output field on a single `Cache.Lookup`, not a second read resource.** `Cache.Entry` carries `ttl` + optional `staleTtl`; `Lookup` returns `state: miss|fresh|stale`. Rejected separate hit/fresh read resources (proliferation + duplicate code paths for one field).
- **Background tasks are owned per resource and drained by the resource's teardown — no pool, no manifest burden.** `ctx.runDetached(fn)` (the bare kernel scope-detach primitive) is tracked by the per-resource `ResourceContext`, which routes failures to the EventBus; the kernel folds a bounded drain into each resource's `teardown()`. So tearing a resource down drains its background work, ordering is correct for free (a resource tears down before its dependencies), and the kernel keeps no task registry. Rejected: a `Run.TaskPool` Service + `tasks: !ref` (manifest bloat for no real gain here); a global kernel task registry (the kernel shouldn't track tasks); an un-awaited promise (orphaned/aborted on teardown, errors swallowed); faking SWR with synchronous revalidate (no latency win). An optional `Run.TaskPool` could return later if isolated/bounded pools are ever needed, without breaking the zero-config path.
- **`Cache.View` is a decorator via existing dispatch — no new contract.** Investigation (`plans/decorator-capability.md`) found Telo already expresses decorators: a layer dispatches its wrapped target through the standard `invoke:` field; extra layers stack via an `inner` field holding an inline nested decorator (never a `!ref`), and the leaf omits `inner`. No new capability, abstract, annotation, or kernel dispatch is added.
- **`Run.Detach` is the generic, zero-config fire-and-forget manifest surface.** Wraps an `invoke:` target and dispatches it via `ctx.runDetached` (no `tasks:` ref). The redirect uses it to record clicks off the response path. Same `runDetached` mechanism as `Cache.View`'s background revalidation — controller and manifest, one primitive.
- **Redis→memory fallback is modeled as `CacheRedis.Store.fallback` (a `Cache.Store` ref), and is observable.** Reusable composition, not app-specific glue. Cache failover is safe (a miss just recomputes); rate-limit failover loosens cross-instance limits, so the degradation is logged + surfaced as a readiness/EventBus signal. Rejected: silent failover (violates "never swallow errors") and bespoke per-app fallback logic.
- **`rate-limit` stores counters in a `Cache.Store`, not its own backend.** One storage seam, one Redis client, natural composition.
- **Client IP comes from a transport-derived `request.ip` (+ `trustProxy` on `Http.Server`), not raw headers.** The guard key stays an explicit, transport-neutral string. Rejected reading `x-forwarded-for` in CEL (fragile, spoofable, leaks transport knowledge into the manifest) and an auto-IP field on the guard (couples the primitive to HTTP). Empty key fails closed.
- **App is a thin `Telo.Application` over two local libraries.** Showcases the recommended decomposition for a comprehensive app; rejected single-file manifest as not representative of a real project's structure.
- **SQLite + memory cache as defaults.** The whole example runs with no external services; Redis is an opt-in variant.

## Complete example after the change (intended behavior)

- `POST /links { url }` → validates, generates a short code, inserts into `links` (SQL), returns `201` with the code. Rate-limited per client.
- `GET /{code}` → reads `code` from cache (read-through to SQL on miss), records the click **off the response path** via `Run.Detach`, returns `302` with `Location: <target>`. Rate-limited; unknown code → `404`.
- `GET /admin/links` → lists links with click counts (SQL `Select`).
- `GET /admin/links/{code}` → single link stats: total clicks + recent clicks (SQL).
- Default run: SQLite file + `CacheMemory.Store`, no infra (imports `std/cache` + `std/cache-memory`). Redis variant: import `std/cache-redis`, point `CacheRedis.Store` at a Redis URL with a `CacheMemory.Store` fallback; pulling Redis down logs a degraded-mode event and serves from memory until it recovers.

### Proposed manifest shapes

These pin down the intended cache + rate-limit API (the new modules don't exist yet; final schemas may refine names).

Resource wiring — backends, guard, and read/write invocables:

```yaml
imports:
  Run: std/run@0.10.0                      # Sequence, Detach
  Cache: std/cache@0.1.0
  CacheMemory: std/cache-memory@0.1.0
  CacheRedis: std/cache-redis@0.1.0       # only for the Redis variant
  RateLimit: std/rate-limit@0.1.0
---
kind: CacheMemory.Store                   # default backend, zero-setup
metadata: { name: MemCache }
maxEntries: 10000
---
kind: CacheRedis.Store                    # Redis variant; degrades to MemCache
metadata: { name: RedisCache }
url: !cel "secrets.redisUrl"
fallback: !ref MemCache                   # a Cache.Store ref — observable failover
---
kind: RateLimit.Guard                     # counters live in any Cache.Store
metadata: { name: PublicLimit }
store: !ref MemCache                      # swap to !ref RedisCache for shared counters
limit: 60
window: 60s                               # sliding window, per key
---
kind: Cache.View                   # leaf decorator; handles miss/fresh/stale
metadata: { name: ResolveTarget }
store: !ref MemCache
invoke: !ref LookupLink                   # wrapped target via standard dispatch (no `inner` — this is the leaf)
ttl: 300s                                 # fresh window
staleTtl: 3600s                           # grace window
revalidate: background                    # serve stale instantly, refresh detached (single-flight, drained on teardown)
---
kind: Run.Detach                          # generic, zero-config fire-and-forget
metadata: { name: RecordClick }
invoke: !ref InsertClick                  # Sql.Exec / SqlRepository.Create; runs off the response path
```

To stack additional decorators, a wrapping layer carries an `inner:` holding an inline nested decorator definition (never a `!ref`); only the leaf uses `invoke:`. The rate-limit guard stays a separate step rather than a decorator layer here, because it must run on **every** request including cache hits — wrapping it around the cache's `invoke` target would skip it on a fresh hit.

`Cache.Lookup` / `Cache.Entry` remain available for manual use; `Cache.Lookup` result is `{ state: "miss" | "fresh" | "stale", value, age }`.

Redirect handler — guard short-circuit + a single read-through call, mapped to responses by the route:

```yaml
kind: Http.Api
metadata: { name: RedirectRoutes }
routes:
  - request:
      path: /{code}
      method: GET
      schema:
        params: { type: object, properties: { code: { type: string } }, required: [code] }
    handler: !ref ResolveAndRedirect
    returns:
      - status: 429
        when: "${{ !result.allowed }}"
        headers: { Retry-After: "${{ string(result.retryAfter) }}" }
        content: { application/json: { body: { ok: false, message: "Rate limit exceeded" } } }
      - status: 302
        when: "${{ result.found }}"
        headers: { Location: "${{ result.target }}" }
      - status: 404
        content: { application/json: { body: { ok: false, message: "Unknown short code" } } }
---
kind: Run.Sequence
metadata: { name: ResolveAndRedirect }
steps:
  - name: guard                           # rate-limit, keyed by client IP
    invoke: !ref PublicLimit
    inputs: { key: "${{ request.ip }}" }   # canonical client IP from the transport
  - name: link                            # one call: miss/fresh/stale handled internally
    invoke: !ref ResolveTarget
    inputs: { key: "${{ request.params.code }}" }
  - name: click                           # fire-and-forget; returns immediately, does NOT block the 302
    invoke: !ref RecordClick
    inputs:
      data: { code: "${{ request.params.code }}", ip: "${{ request.ip }}" }
outputs:
  allowed: "${{ steps.guard.result.allowed }}"
  retryAfter: "${{ steps.guard.result.retryAfter }}"
  found: "${{ steps.link.result.state != 'miss' }}"
  target: "${{ steps.link.result.value }}"
```

Shape decisions encoded above:

- `Cache.Lookup` / `Cache.Entry` / `Cache.View` are invocables carrying a `store` ref (not methods on the store), so they compose in `Run.Sequence` and the store stays a pure provider. `Lookup` result: `{ state, value, age }`; `Cache.View` returns the same shape with miss/stale resolved against its `invoke:` target.
- `RateLimit.Guard` is **non-throwing** — returns `{ allowed, remaining, retryAfter }` and the caller maps the response (here `429`). Keeps it transport-neutral and testable; rejected a guard that short-circuits at the transport layer.
- `window` / `ttl` are duration strings (`60s`, `300s`) rather than integer seconds, for readability.
