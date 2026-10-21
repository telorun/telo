---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Four annotations for typing data a resource holds by reference.

- `x-telo-context-from-referrer: "<binding>"`, on a binding marked `x-telo-context-eval: accessor` alone, types the binding from the binding of that name in scope at each slot referencing the resource, following chains of such bindings. A site is judged once per distinct type its referrers give. A finding only some referrers' types make names those referrers, and a referent declared in another module is reported at the entry's referencing slot. The editor offers a member only when every referrer's type declares it. Misuse is `CONTEXT_FROM_REFERRER_INVALID`.
- `x-telo-context-item-fills: [<pointer>…]`, on a binding of a region declared on a list, names the member each item fills. Items whose accessor chains, or those of resources they forward the binding to, read each other's members in a cycle are `CONTEXT_FILL_CYCLE` at each read. The kernel refuses them through its load analysis. Misuse is `CONTEXT_ITEM_FILLS_INVALID`.
- `x-telo-value-schema-from` gains `{ from, member }`. `member` is a Relative JSON Pointer (`0#` for a map value's own key) naming the property of each reached type that the value must satisfy. A member that names no key or no string is `VALUE_SCHEMA_FROM_INVALID` / `ERR_VALUE_SCHEMA_FROM_INVALID`. On a configuration slot every expression, accessors included, now joins the CEL slot-fit check (`CEL_TYPE_ERROR`).
- A rule's `resolve:` pointer may continue past a reference into the declaration it names, and range with `*`. Referrer rules gain `resolveSelf:`, which binds `self` with its own reference slots resolved. A referrer-rule code is unique per `referrer:` filter.
- A library's own `Self.<fn>` / `<LibName>.<fn>` calls resolve to its exported functions in an importer's analysis too, so a rule condition calling one is evaluated there instead of reported as calling an unbound function. A re-exporter's `Self.` does not name what it only re-exports.
