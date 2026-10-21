---
"@telorun/analyzer": minor
---

`x-telo-context-element-from-item` takes a Relative JSON Pointer from the object holding the field the region is declared on (`0/rows` a sibling field, `2/rows` a member two levels up), and the chain at the named field is typed exactly as at its own site, every region covering it merged — so a list column's `row` is typed from a `rows` chain rooted at a binding of an enclosing region. A pointer outside the grammar is `SCHEMA_VIOLATION`; one that climbs above the resource or the named shape, names an undeclared member, lands at or beneath the region's own field, or names a field that declares no `x-telo-eval` is `ELEMENT_FROM_ITEM_INVALID`. The bare field name earlier releases wrote is rewritten to `0/<field>` at load by the core migration `element-from-item-relative-pointer`, with the warning `DEPRECATED_ELEMENT_FROM_ITEM_FIELD`.
