---
"@telorun/cli": patch
---

cli: two debug event serializer fixes.

- The serializer no longer mislabels a **shared reference** as `[Circular]`. `toWire`'s cycle detection is now path-scoped (a value is "circular" only while it's an ancestor on the current descent), so an object reachable by two sibling paths — a DAG, common in invocation `inputs` where a sub-value is shared — serializes fully. Genuine cycles still collapse to `[Circular]`.
- A **bigint** now serializes as a plain number when it fits a JS safe integer (CEL models small integers as bigint, so `${{ size(x) }}` reads as `3`, not `[BigInt 3]`), falling back to its decimal digits as a string for out-of-range values so no precision is lost.
