---
"@telorun/cache": minor
"@telorun/cache-redis": minor
"@telorun/rate-limit": minor
"@telorun/sql": minor
"@telorun/shell": minor
"@telorun/vector-store": minor
"@telorun/vector-store-pgvector": minor
"@telorun/embedding": minor
"@telorun/record-stream": minor
---

Resolve provider-shaped `!ref` slots through `ctx.resolveRef` instead of a
per-module copy of the same two-branch logic.

The removed wrappers (`resolveCacheStore`, `resolveShellHost`,
`resolveVectorStore`, `resolveEmbeddingModel`, `resolveJournal`) were one-line
shims; call sites now pass the module's own type guard and the slot's `x-telo-ref`
contract, so a mis-wire names the owning resource and what the slot wanted —
``Cache.Entry "page": 'store' … did not resolve to a resource satisfying
`std/cache#Store` ``. Each module still
exports its guard (`isCacheStore`, `isShellHost`, `isVectorStore`,
`isEmbeddingModel`, `isJournalStore`, `isSqlConnection`) for consumers that
resolve the slot themselves; `isJournalStore` is now duck-typed rather than
`instanceof`, so it survives two copies of the package in one process.

`resolveSqlConnection` stays — it encodes the optional-slot rule that lets a
`Sql.Query` fall back to its `transaction` — and now takes a `describe` argument,
so its six call sites report the owning resource instead of a bare `Sql:` prefix.
Ref-typed manifest fields use the SDK's `KindRef<T>` rather than a hand-rolled
`{ name, alias }`.
