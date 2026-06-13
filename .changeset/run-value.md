---
"@telorun/run": minor
---

Add `Run.Value`, a pure value/binding invocable. It returns a CEL expression — or
a structure with CEL leaves, or a plain constant — evaluated over the caller's
`inputs`, with no JavaScript. It is the declarative, type-safe replacement for a
`Js.Script` that only shapes a value (concat, field mapping, arithmetic, a constant
literal); I/O and branching still belong in `Js.Script`.
