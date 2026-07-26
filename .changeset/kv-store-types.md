---
"@telorun/kv-store": minor
---

Initial release: the `KvStore.Store` contract plus `KeyedClaim`.

`KvStore` is four conditional-write primitives — `get`, `putIfAbsent`,
`compareAndSet`, `compareAndDelete` — over an opaque revision token. `KeyedClaim`
implements the claim → renew → settle | release protocol once on top of them, so
`Lease.Critical` and `Idempotency.Once` share one state machine instead of each
backend re-expressing the same ownership guard in JavaScript, SQL, and Lua.
