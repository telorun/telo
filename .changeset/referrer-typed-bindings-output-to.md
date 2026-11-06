---
"@telorun/analyzer": minor
---

Two generic analyzer primitives for kind authors.

- **`x-telo-context-from-referrer`** now works on evaluated bindings as well as accessor ones, and also on a member beneath a binding. Its value becomes a path, `<binding>[/<member>…]` (for example `request/principal`).
  - The referrer's scope is read at the annotated site's own eval mode.
  - Each referrer's type replaces the node's own keywords. With no referrer, or where a referrer's scope lacks the path, the node keeps its own keywords.
  - A parent's `x-telo-context-from` merge no longer overwrites a member that carries its own typing annotation.
  - The accessor-only restriction is gone. `CONTEXT_FROM_REFERRER_INVALID` now covers the annotation outside a binding's subtree, or beside another typing annotation on the same node.
- **`x-telo-context-nullable-when: { at, equals, absent }`** is a new annotation. It makes a binding, or a member beneath one, nullable wherever the resource's value at `at` is one of `equals`, or, with `absent: true`, where nothing is there.
  - `at` is a relative pointer from the context holder.
  - A schema `default:` fills a member only when the object holding it is present.
  - A computed or undecided value counts as a match.
  - An unguarded member read where the node is nullable is `CEL_NULLABLE_ACCESS`.
  - A misdirected rule is the warning `CONTEXT_NULLABLE_WHEN_INVALID`.
- **`x-telo-ref` gains `outputTo: { slot, member }`.** The slot's target's output, with null removed, must fit the input member `member` of the target in the sibling slot `slot`. A source that cannot fit is `CONTRACT_INPUTS_MISMATCH` at the source. A malformed or misdirected `outputTo` is `X_TELO_REF_INVALID_OUTPUT_TO`.
