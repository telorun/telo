---
"@telorun/analyzer": minor
---

Add the `x-telo-context-element-from` CEL-context annotation. On a context variable, it derives the variable's schema from the element type of a sibling collection expression — when that collection is a member-access chain into the resource's typed `inputs` contract, the variable is typed as the array's `items`; non-chain or untyped collections fall back to `dyn` (no false positives). This lets `std/run`'s `Run.Iteration` / `Run.Projection` type `item` automatically from `collection`, so `item.<unknownField>` is a `CEL_UNKNOWN_FIELD` with no author annotation.
