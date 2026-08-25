---
"@telorun/analyzer": minor
---

Two analyzer changes the declared-schema surface needs.

**A projection can be pointed at its own resource.** `x-telo-schema-projection-from`
with the EMPTY pointer names the declaration it is written on rather than a slot
holding a reference to another — resolution is skipped, the declaration is already
in hand. That is what lets a kind type its own data against its own entries: a
table's seed rows against its `columns:`, so a misspelled column is an error on
the row's own line. Projections are now resolved when validating a resource
against its kind's schema, per resource, because a projection is
declaration-derived — the same kind schema yields a different row shape for every
table. A failure to resolve one is reported there as
`SCHEMA_PROJECTION_FROM_UNRESOLVED`, which had been reported only for contract
slots.

`resolveSchemaProjections` now returns a node **by identity** where nothing
projected. `DefinitionRegistry` memoizes its compiled AJV validator per schema
OBJECT — every resource of a kind is checked against the same one at keystroke
time — so rebuilding each node unconditionally missed that memo for every resource
in the analysis and recompiled the whole kind schema per resource. The
inheritance-merged author schema and its injected `kind` / `metadata` are memoized
per definition for the same reason. On `apps/hub` that is 723 ms of AJV compilation
down to 94 ms, and it applies to every kind rather than only to projecting ones.

**A migration entry, `schema-prepare-bucket`**, rewriting `beforeMigrations:` to
`prepare:` on the two backend schema kinds. A manifest published with the old
spelling keeps loading; the region is the key itself, which is the tightest
containment the vocabulary can state.
