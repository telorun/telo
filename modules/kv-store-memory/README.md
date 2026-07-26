# Durable Store — Memory

`KvStoreMemory.Store` — an in-process [`KvStore.Store`](../kv-store/README.md) backend.

## Why use this

- **Zero dependencies** — no database, no Redis, no configuration.
- **Genuinely atomic for one process** — every operation runs to completion without yielding, so a conditional write cannot interleave with another caller's inside the event loop.
- **Ideal for tests** — the same code path as production, with no service to stand up.

## Scope — read this before using it in production

Records live in memory. They do **not** survive a restart and are **not** shared across instances. The at-most-once and mutual-exclusion guarantees therefore hold for exactly one process:

- Two instances behind a load balancer each get their own store, so both can win the same conditional write.
- A restart forgets every record, so an operation may run a second time.

Use `kv-store-sql` or `kv-store-redis` anywhere the guarantee must outlive the process.

## Fields

| Field | Purpose |
| --- | --- |
| `maxEntries` | Safety ceiling on retained records (default 100000), so a runaway key space cannot exhaust memory. Reaching it **errors** (`ERR_STORE_FULL`) — dropping a record would break the non-eviction guarantee this store exists to provide. |

## Example

```yaml
kind: KvStoreMemory.Store
metadata: { name: store }
---
kind: Lease.Critical
metadata: { name: reconcileOnce }
store: !ref store
ttl: "5m"
invoke: !ref reconcile
```
