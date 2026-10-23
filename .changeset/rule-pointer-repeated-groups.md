---
"@telorun/analyzer": minor
---

A resource rule's `in:` pointer may name several collections: `*` is every item of a list or value of a map, and a group followed by `)*` repeats zero or more times — the eval-path grammar's repeated group spelled as pointer segments, with `|` between alternatives (`in: /navigation/items(/*/items)*`) — so one rule visits every entry of a tree of unknown depth and anchors each violation at that entry. The strict half follows local and named-shape `$ref`s and union branches through the kind's schema, and refuses a group that reaches nothing (`RESOURCE_RULE_INVALID`). A key holding `(`, `)` or `|` cannot be named.
