# Lease

`Lease.Critical` — a **declarative critical section** over a [`Cache.Store`](../cache/README.md). It wraps a body and owns the whole `acquire → run → release` lifecycle around it, so a manifest never issues imperative acquire/release calls — the same decorator shape as `Cache.View` (wraps caching) and `Sql.Transaction` (wraps begin/commit/rollback).

## Why use this

- **At most one holder per `key`** — a conversation, a job name, a tenant, a resource id. A second attempt while one is active does **not** run the body; it reports the current holder so the caller can branch (skip, or return 409).
- **Self-healing** — leases are time-bounded (`ttl`). If a holder dies without releasing, the lease frees on expiry; no stuck locks.
- **Race-free & shareable** — the atomic gate is `Cache.Store.increment`, so the mutex is correct across concurrent callers and shared across instances when the store is (`CacheRedis.Store`).
- **No imperative actions** — there is no `Acquire`/`Release` kind to misuse. The lifecycle is structural.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `Lease.Critical` | Invocable | Run a body under a keyed lease, auto-managing acquire/release. |

## Two modes

**Synchronous (default)** — acquire → run `invoke` inline → release on return **or** error. Returns `{ acquired: true, result }`, or `{ acquired: false, holder }` if the lease is held.

```yaml
kind: Lease.Critical
metadata: { name: nightlyReport }
store: !ref Counters
ttl: 10m
invoke: !ref buildReport
# invoked with { key: "report", inputs: {...} }
#   acquired → { acquired: true, result }
#   held     → { acquired: false, holder }   # a concurrent cron tick SKIPS
```
Use for cron-overlap prevention, migrations, singleflight, idempotent handlers.

**Detached (`detach: true`)** — acquire → dispatch `invoke` **detached**, hold the lease across it, release on the detached body's **terminal**. Returns `{ acquired }` *synchronously* (no `result`). The lease resource must own the detach so the hold can outlive the call while the acquire outcome is still returned in time to branch (e.g. 200 vs 409).

```yaml
kind: Lease.Critical
metadata: { name: perConversation }
store: !ref Counters
ttl: 5m
detach: true
invoke: !ref turnRunner
# POST handler invokes it with { key: conversationId, holder: turnId, inputs: {...} }
#   acquired → 200 { turnId }   (turnRunner runs detached; lease frees on its terminal)
#   held     → 409 { holder }   (holder = the in-flight turn id)
```
Use for "at most one background operation per key" — a per-conversation agent turn, a per-tenant reconciliation, a per-resource webhook processor.

## `holder`

The optional `holder` input is an opaque token identifying this holder; it's returned to a loser (so a 409 can name the in-flight operation) and doubles as the **release guard** — a stale holder whose lease already expired and was taken over by another owner cannot release the new owner's lease. A unique token is generated when omitted.

## Composition

`Lease.Critical` handles only mutual exclusion; it composes with the other coordination primitives rather than absorbing them. A resumable, cost-bounded background operation wires: `Lease.Critical` (one turn per key) + `RateLimit.Budget` (reserve/settle cost) + `RecordStream.Journal` (resumable stream) + `Run.Detach` semantics (built into the detach mode).
