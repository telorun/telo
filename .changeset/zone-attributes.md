---
"@telorun/analyzer": minor
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Zone attributes: a body slot that establishes an execution zone can now declare what the region guarantees about everything inside it.

`x-telo-provides-zone` gains an object form carrying its correlation key as `key` beside the attributes — `atomic`, `idempotent`, `noSuspend`, `replayed`. The vocabulary is CLOSED and ships as data (`sdk/zone-attributes/*.json`), so both kernels read one vocabulary rather than one written in TypeScript; each attribute's value is the author's REASON, which whatever enforces it quotes verbatim, and `requires:` on an entry compiles to JSON Schema's `dependentRequired` so `atomic ⇒ noSuspend` lives in the data rather than in a validator.

The analyzer gains a downward **containment walk** (`findZoneRegions`), parameterized over the attribute that opens a region rather than over any kind, plus `ZONE_ATTRIBUTE_UNKNOWN` and `ZONE_ATTRIBUTE_INCOMPLETE`. The kernel gains `ctx.zoneAttributes()`, which resolves the attributes off the declaring kind's schema — never off the `ZoneEntry`, which stays three identities so it remains ABI-serializable — and returns them without branching on any name.
