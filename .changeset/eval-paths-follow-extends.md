---
"@telorun/analyzer": minor
---

An `extends` child no longer reports `CEL_IN_NON_EVAL_FIELD` for a CEL-bearing
field it inherits from its parent.

Without `base:`, a child is authored against merge(parent, own), and the kernel
stamps that merged schema at definition registration — so it expands an
inherited `x-telo-eval` / `x-telo-context` field correctly. The analyzer built
its eval paths from the child's OWN schema, so the same expression the runtime
evaluated was reported as never evaluated. The two halves now read the same
schema.
