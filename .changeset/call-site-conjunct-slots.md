---
"@telorun/analyzer": patch
---

**A `!cel` argument is typed where the target's input is derived from a type it names.** An input contract node carrying `x-telo-value-schema-from` resolves to an `allOf` of the types reached, and the walk pairing each expression with its slot read a node's own `properties` only — so every expression beneath such a node met an empty slot and a mistyped one reported nothing, an accessor chain included. A member or an item is now read from every `allOf` conjunct that declares it: an expression whose type a reached type refuses is `CEL_TYPE_ERROR` at the argument, naming the target's declared inputType, and a leaf several conjuncts declare is reported once. A manifest passing an expression of the wrong type to such a target, which failed at dispatch with `ERR_INPUT_INVALID`, is now refused by `telo check`.
