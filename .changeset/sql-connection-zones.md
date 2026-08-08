---
"@telorun/sql": minor
"@telorun/sql-sqlite": minor
---

`SqlConnection` carries transaction state through the kernel's execution-zone
stack instead of a module-global `AsyncLocalStorage`. `transaction(cb)` becomes
`runInTransaction(body)`, which hands the caller a `bind` for keying the open
executor on the zone entry it minted, plus `hasOpenTransaction()` for the
nesting check; `execute` / `executeTemplate` take an optional `ZoneEntry` where
they took a `SqlTransactionResource`. `SqlConnectionBase` now requires a
`ResourceContext` (it reads the ambient stack, scoped to itself) and keeps its
executor map as an **instance field**.

That last part is the fix, not a detail: a module's controllers ship as separate
bundles that each inline their own copy of a shared source file, so the previous
module-scoped store was one `AsyncLocalStorage` per bundle — the write and the
read never met, and a statement declaring `transaction:` threw on every path.
The map lives on the connection, the object both sides hold by reference, and a
zone this connection did not open now raises `ERR_SQL_ZONE_FOREIGN` rather than
falling back to the unzoned executor, since that fallback would turn a delivery
split into silently non-transactional writes.

A backend extending `SqlConnectionBase` passes `ctx` to `super(...)`; nothing
else changes for it.
