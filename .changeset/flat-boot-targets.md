---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/run": patch
---

Add flat invoke steps and conditional `when` guards to Application `targets`, so a
runnable app can sequence and gate boot-time work without importing `std/run`.

Alongside the existing bare reference, a `targets` entry now accepts:

- a gated reference `{ ref: <Runnable/Service>, when?: <CEL> }` — `run()` only when
  the guard holds;
- an inline invoke step `{ name?, invoke: <Invocable/Runnable ref>, inputs?, when? }`
  — call an Invocable on boot, with `steps.<name>.result` plumbed into later
  targets and an optional `when` guard.

The flat invoke leaf (`when` + `inputs` expansion + ref resolution + `retry` +
`steps.<name>.result`) is now a single shared primitive `executeInvokeStep` in
`@telorun/sdk`. The kernel boot runner and the `Run.Sequence` controller both
consume it, so the leaf semantics are single-sourced — `Run.Sequence` keeps
control flow (`if`/`while`/`switch`/`try`), `with:` scopes, and the callable
`inputs`/`outputs` wrapper.

The analyzer's reference-field-map descends into object `anyOf` variants on a ref
node, so nested refs like `targets[].invoke` register and resolve; reference
validation skips the item-level `{kind, name}` check for the inline/gated object
forms.

`targets` are ref-only for now: inline targets reference declared resources
(`!ref` / `{kind, name}`); inline resource definitions remain a `Run.Sequence`
feature. Static CEL type-checking of target `when`/`inputs` and editor support
for the new target forms are follow-ups.
