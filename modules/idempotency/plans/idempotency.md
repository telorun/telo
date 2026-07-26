# idempotency — durable at-most-once execution

## Problem

An operation that acts on the outside world — charging a card, sending an email,
firing an outbound webhook — must execute **at most once**, even across retries
and process restarts. Composing `Lease.Critical` + `Cache` gets close but leaves
a window between "has this already completed?" and "claim it," which is exactly
where a double-execution slips through. A robust system needs a primitive with no
such gap.

The same gap already undermines what Telo ships today. `Lease.Critical` is
`Cache.Store`-backed, and a cache is *evictable by design*: an evicted lease
record means two holders run the body — precisely the failure the lease exists to
prevent. So the missing piece is not "a store for idempotency"; it is **one
durable, non-evicting key/value store with atomic conditional writes**, which both
idempotency and leasing are consumers of.

## Solution

Three pieces: a shared durable store, the idempotency decorator on top of it, and
migrating `lease` onto the same store.

### 1. `kv-store` — the shared primitive

A new stdlib module `kv-store` (namespace `std`) with a `Telo.Abstract`
`KvStore.Store`: a **durable, non-evicting key/value store with atomic conditional
writes**. Four primitives:

- `get(key)` → `{ value, version } | null` — absent and lapsed are one state.
- `putIfAbsent(key, value, ttlMs)` → `{ value, version } | null` — atomic; writes
  only when the key is free. Redis `SET NX PX`, SQL unique-key
  `INSERT … ON CONFLICT DO UPDATE … WHERE <expired>`.
- `compareAndSet(key, expectedVersion, value, ttlMs)` → `{ value, version } | null`
  — atomic; also how a TTL is extended.
- `compareAndDelete(key, expectedVersion)` → boolean.

`version` is an opaque store-generated revision token. A `null` return is
CONTENTION, not failure: the caller lost the race and needs no try/catch.

**Storage, not protocol.** The claim state machine (`held` / `settled`) is NOT in
the abstract. It lives in `KeyedClaim`, a small class in `@telorun/kv-store`
implemented once over the four primitives, and both consumers use it. Putting the
protocol in the abstract forces every backend to re-express the same ownership
guard — in JavaScript, in SQL `WHERE` clauses, and in Lua — which is three times
the surface for a bug that admits a second holder. It also blocks any consumer
that wants a conditional write for something other than a claim (leader election,
a counter, a cursor).

Three drivers ship, each its own module, mirroring `cache` / `vector-store`:

- `kv-store-memory` — single-process, non-durable across restarts. Explicitly a
  development and test driver.
- `kv-store-redis` — `SET NX PX` for `putIfAbsent`, plus TWO generic Lua scripts
  for the compare-and-* pair (generic because they compare a revision and know
  nothing about what the value means).
- `kv-store-sql` — backed by the `Sql.Connection` abstract, so it runs on
  **Postgres** (`sql-postgres`) and SQLite (`sql-sqlite`) without a
  database-specific module. Supported dialects are stated explicitly: the
  `ON CONFLICT … DO UPDATE … WHERE` form is Postgres/SQLite syntax.

### 2. `Idempotency.Once`

A new stdlib module `idempotency` (namespace `std`) with a `Telo.Invocable`
decorator kind, `Idempotency.Once` — the wrap-a-body shape of `Lease.Critical` /
`Cache.View`. It wraps an `invoke` (`anyOf: [telo#Invocable, telo#Runnable]`), is
backed by a `KvStore.Store` (through `KeyedClaim`), and is keyed by a
caller-supplied idempotency key. Semantics:

- **New key** → `claim` succeeds, the body runs, and `settle` persists the result
  under the key for a retention `ttl`.
- **Already settled** → replay the stored result without re-running (caller
  branches on `executed`).
- **Concurrent second call while held** → does not run the body (mirrors lease's
  `acquired`), so there is no double-execution window.
- **Body failed** → `release` the key (retryable); failures are never persisted as
  a permanent completion. The body's error is surfaced, never swallowed.
- **Holder died mid-body** → the hold lapses after `claimTtl` and the next call
  re-claims and re-runs. Without a bounded claim the key would stay held forever
  and the operation could *never* be retried — a permanently wedged key, a worse
  failure than the double-execution the kind prevents.

Two durations, deliberately distinct: `claimTtl` bounds how long a body may hold
the key before another caller may take over (set above the body's worst-case
duration; the controller `renew`s on a heartbeat for long bodies), and `ttl` is
how long a *settled* result is remembered. `inputType` is `{ key, inputs }`;
`outputType` is `{ executed, result }`.

### 3. `lease` migrates onto `KvStore.Store`

`Lease.Critical`'s `store` field re-points from `std/cache#Store` to
`std/kv-store#Store`, and its mutex moves from `Cache.Store.increment` to
`KeyedClaim` over the new primitives. This is the point of extracting the primitive: the
lease stops resting on an evictable store, and the two consumers share one
backend rather than standing up parallel abstracts. `lease`'s public shape is
otherwise unchanged (same `key` / `ttl` / `detach` / `acquired` contract).

### Controller delivery

`Idempotency.Once`, the three `kv-store` drivers, and lease's rewritten
controller all ship **bundled with their module** as `pkg:telo/local/js` — a built
`.mjs` next to the manifest, referenced as
`pkg:telo/local/js?path=./nodejs/<file>.mjs#<export>` and imported directly by the
kernel, with no npm package to publish. Each manifest declares a `files:` glob
covering the built `.mjs` so the bundle ships in the published artifact; no
stdlib module uses bundled delivery yet, so the build step producing the `.mjs`
and the `files:` entries are part of this work. The SDK stays an external import
resolved to the kernel's own copy by the bundle loader.

## Decisions

- **Self-contained gate, not layered on `Lease.Critical`** — at-most-once means no
  window between "is it done?" and "claim it"; a replay-only kind wrapped by an
  external lease reintroduces exactly that gap and depends on the author
  remembering the lease. `Idempotency.Once` subsumes single-flight for its key.
  Rejected: replay-only kind + a caller-supplied lease.
- **The abstract is storage, the claim is a protocol on top** — an abstract
  exposing `claim`/`settle`/`release` reads as convenient but pushes one state
  machine into every backend, so the identical ownership guard gets written in
  three languages. Four KV primitives plus a shared `KeyedClaim` means a backend
  implements only what its engine does natively, the state machine has one home,
  and a future consumer needing a plain compare-and-set is already served.
  Rejected: a protocol-shaped abstract (what this plan originally specified).
- **One shared `KvStore.Store`, not an idempotency-private abstract** — the
  argument that a cache's eviction breaks at-most-once applies verbatim to
  `Lease.Critical`, so shipping a private store for idempotency would leave the
  weaker guarantee in place next to the stronger one and give the runtime two
  overlapping durable-claim abstracts. Leasing is the second consumer that makes
  the generic primitive concrete rather than speculative, which is the repo's
  stated default. Rejected: an `Idempotency.Store` abstract; `Cache.Store`
  backing (a *freshness* contract — `miss`/`fresh`/`stale`, evictable under
  pressure — so an evicted `settled` record silently allows a re-execution).
- **Bounded `claimTtl` separate from retention `ttl`** — a single duration cannot
  express both "how long may a body hold this key" and "how long is a completed
  result remembered"; conflating them either lets a crashed holder wedge the key
  or expires results while work is still in flight. The claim is a self-healing
  hold (the property `Lease.Critical` already has), the settlement is durable
  retention. Rejected: one `ttl`; an unbounded in-flight claim.
- **Its own module, not a kind inside `lease`** — "lease" names a *time-bounded,
  releasable* hold; idempotency *retains* the key and its result (the inverted
  settlement contract). Co-locating would make the module name lie, and it can't
  be `extends` either (an idempotency instance is not Liskov-substitutable for a
  lease — it never releases on success). Matches the decorator-per-module
  convention (`lease`, `rate-limit`, `cache`). Rejected: `Lease.Once` / a `retain`
  flag on `Lease.Critical`.
- **Failures retryable, not cached** — a transient failure must be retryable; the
  *deterministic* key ensures the retry targets the same logical operation.
  Exactly-once against an external system still requires that deterministic
  client-side id plus server-side reconciliation — which this primitive enables
  by making the key deterministic and durable.
- **The SQL driver targets `Sql.Connection`, not a specific database** — database
  specificity already lives in the `Sql.Connection` drivers (`sql-postgres`,
  `sql-sqlite`); one `kv-store-sql` over the abstract runs on any of them via
  a single `INSERT … ON CONFLICT`. Rejected: a database-specific
  `kv-store-postgres` that would re-implement connection handling.
- **`invoke`, not `target`, for the wrapped body** — `Lease.Critical` and
  `Cache.View` both name the wrapped body `invoke`, as do `Run.Sequence` steps and
  the Application's inline boot steps. One name for "the thing this dispatches"
  across the stdlib. Rejected: `target`.
- **No shared `Redis.Connection` in this change** — `kv-store-redis` takes its
  own connection config, matching `cache-redis`. Because lease and idempotency now
  share one store, this adds a single Redis configuration surface, not two.
  Extracting a `Redis.Connection` abstract that `cache-redis` and
  `kv-store-redis` both compose is the documented follow-up. Rejected: doing
  it inline here (it re-opens `cache-redis`'s published contract for no gain to
  this change).
- **Controllers bundled (`pkg:telo/local/js`), not published npm packages** — the
  new controllers are JS and each ship with their module, dropping the whole
  publish/versioning surface (no `@telorun/idempotency`, no controller changeset;
  modules version via changie alone). Rejected: new `@telorun/*` npm packages.

## Usage after the change

Charge a payment at most once, keyed by a deterministic request id:

```yaml
kind: Idempotency.Once
metadata:
  name: idempotentCharge
store: !ref chargeStore     # a KvStore.Store (kv-store-sql driver)
claimTtl: "2m"              # how long one caller may hold the key while running
ttl: "24h"                  # how long a settled result is remembered
invoke: !ref chargePayment  # the raw outbound call it guards
```

Invoked from a `Run.Sequence` step: `key` is the deterministic request id,
`inputs` are forwarded to the wrapped call, and `executed` distinguishes a fresh
execution from a replay.

The same store backs a lease, so one backend serves both:

```yaml
kind: Lease.Critical
metadata:
  name: reconcileOnce
store: !ref chargeStore
ttl: "5m"
invoke: !ref reconcile
```
