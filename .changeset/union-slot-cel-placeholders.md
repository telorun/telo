---
"@telorun/kernel": minor
---

A union-typed slot can hold a whole-field CEL expression. The compiled-value
strip handed every leaf under an `anyOf` the schema-unaware `""` placeholder,
because a union carries no `type` / `items` / `properties` of its own — so a
`!cel` inside a list of integers was rejected at resource creation as
`/success/1 must be integer`, against a value the author never wrote. The walk
now resolves the branch first, through the analyzer's `selectUnionBranch`, so
the static and dispatch halves cannot disagree about which branch a value was
written against; a union with no `type` takes the first branch that yields a
placeholder, mirroring `celPlaceholderForSchema`.
