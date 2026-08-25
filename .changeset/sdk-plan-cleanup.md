---
"@telorun/sdk": patch
---

No runtime change. The landed `invocable-errors` plan was removed from
`sdk/nodejs/plans/`, and the Rust half's `mirror-nodejs-docs` plan from
`sdk/rust/plans/`, as part of clearing plans whose work has shipped — a plan
describes the current state of the world, not how it was reached.

`plans/` is outside the package's `files`, so the published payload is
unchanged. The changeset exists because the PR gate is path-based and cannot
tell an unpublished directory from a published one.
