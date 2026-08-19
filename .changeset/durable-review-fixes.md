---
"@telorun/analyzer": patch
"@telorun/sdk": patch
"@telorun/kernel": patch
---

Durable-execution correctness fixes found in review.

**A live value is now actually refused.** `assertJournalable` used `JSON.stringify`, which SUCCEEDS on a stream and returns `{}` — so the case the contract names first was recorded as an empty object and replayed as one. Detection is now structural, through the value-type vocabulary's own binding table, and lives in `@telorun/sdk` because it is a property of the contract rather than of one journal. The static half is only a warning precisely because "the runtime is the gate"; the gate was open.

**`DURABLE_NONDETERMINISM` reads parsed call sites** (`auditCalls`) instead of a regex over CEL source. A regex fires on a name inside a string literal and on an unrelated receiver method, and re-derives what the registry's `deterministic` flag already answers — the text-matching this repo retired elsewhere.

**`ctx.zoneAttributes` resolves along `extends`** so a child inheriting a zone-providing slot reports what that slot declares, and no longer memoizes an unresolved kind (which would make a transient miss permanent).

**A step with no name is refused** rather than defaulting to an empty path segment, where two such steps would share one journal key and the second would be handed the first's result. The shared `Step` schema requires `name`, so a manifest cannot reach this; a caller assembling steps in code can.

Also: the CEL walk now stops at a nested `{ kind }` declaration rather than reporting that resource's expressions against its enclosing one, and the unused `zoneAttributesSchema()` is removed — the property it was meant to guarantee (the `atomic ⇒ noSuspend` rule living in the data) is already true, since the validator reads `requires:` off the entry.
