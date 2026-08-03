---
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Modules now report which kernels can run them, and deprecation is structured
rather than prose.

`telo module manifest --json` gains a `runtime` block classifying every kind by
the kernels that can host it, derived from its `controllers:` PURL candidates:
`pkg:cargo` runs on both kernels (the Node kernel builds the crate as a napi
addon, the Rust kernel opens it as a cdylib), `pkg:npm` and a bundled
`pkg:telo/local/js` on Node alone, and a format no kernel hosts contributes
nothing. Telo is polyglot, so this is a capability rather than trivia — without
it a consumer composing for the Rust kernel is offered kinds it cannot load.

The classification is per KIND, and the module roll-up distinguishes full from
partial coverage, because coverage genuinely differs within one module:
`std/console` ships Rust controllers for two of its four kinds, so a boolean
would claim the whole module runs on the Rust kernel. A kind declaring no
controllers is reported as `portable` — no kernel constraint — rather than
having today's kernels enumerated into it, which would make the record wrong
the day a third kernel ships. Language is tracked as a separate axis from
runtime and is left blank for a `napi`/`wasm` bundle, whose source language the
PURL does not determine.

`@telorun/analyzer` gains the first validation of the `metadata:` block on
`Telo.Application` / `Telo.Library` docs, which previously had no schema at all.
Known fields are type-checked, the vocabulary stays open, and an unknown key is
reported only when it is a near-miss of a known one — nothing in the kernel
reads these fields, so a mistyped `licence:` or `deprecatd:` has no runtime
failure mode and would otherwise ship unnoticed.

Two new fields are recognized: `metadata.homepage`, and `metadata.deprecated`
with a `reason` and an optional `replacedBy`. The replacement is resolvable
rather than free text, and its form follows the level — a module doc names
another module ref, a kind doc names an alias-qualified kind (`Self.Migrations`,
`Telo.JsonSchema`) resolved through the declaring file's own imports, exactly as
`extends:` is. `INVALID_DEPRECATION` and `DEPRECATION_REPLACEMENT_UNRESOLVED`
report a replacement a consumer could not follow.
