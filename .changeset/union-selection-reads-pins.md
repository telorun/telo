---
"@telorun/analyzer": minor
---

A `oneOf` / `anyOf` value is now matched to its branch by the `const` / `enum` pins its literals fall under, not only by kind and `required` keys: a branch is dropped when a literal the author wrote — the value itself, or an object member written as a plain scalar — falls outside a pin the branch carries, read through `$ref`, through a union of constants, through the branch's `allOf` parts and over the union's shared base, a branch that is itself a union fitting when one of its branches does. A union tagged on a member such as `type` is therefore decided by the tag, so `telo check` types the expressions inside it against the tagged branch alone and the kernel holds a compile-eval result to that branch at creation. A tag written as an expression decides nothing, as before. The Rust analyzer (`telo-analyzer`) selects a branch by the same rule.
