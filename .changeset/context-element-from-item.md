---
"@telorun/analyzer": minor
---

**A context binding can be typed from a list the resource's own accessor names.** `x-telo-context-element-from-item: "<field>"` on an `x-telo-context` property types that binding as the element of the collection the enclosing array item's `<field>` points at, where the field holds a plain chain rooted at another binding of the same context (or at `inputs`). A kind whose entries each name their rows (`rows: !cel "result.files"`) gets `row` typed per entry, so a member the element does not declare is `CEL_UNKNOWN_FIELD` in the columns beneath it. A chain that cannot be followed to a collection leaves the binding untyped and reports nothing. `x-telo-context-element-from` is unchanged.
