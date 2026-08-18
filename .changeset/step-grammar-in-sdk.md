---
"@telorun/analyzer": minor
"@telorun/cli": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

The step grammar becomes shared vocabulary, and its execution moves to the SDK.

`$ref: "telo://manifest#/$defs/Step"` on an array's items declares a step body —
`invoke` / `value` / `if` / `while` / `switch` / `try` / `throw`, the
`steps.<name>.result` accumulator and the `error` variable inside a `catch:`. Any
kind can carry one now; a composite kind that wraps a region of work no longer
needs a `!ref` to an executable and a second document to hold it. The grammar was
declared four times inside `modules/run/telo.yaml`, and `$defs` are local to the
schema that declares them, so four kinds in one module could not share one.

`StepEngine` moves from `modules/run` to `@telorun/sdk` beside the
`executeInvokeStep` leaf it already delegated to, against a structural context
(`StepEngineContext`) so it depends on neither the kernel nor `run`. The SDK is
the one name the bundle loader symlinks onto the kernel's own copy, so the engine
is one version per process and reachable from a controller bundle and the
kernel's boot runner alike.

Two consequences for a kind author. `while/do` is admitted in every step body —
a fragment cannot be narrowed by its consumer, and the copies that dropped it did
so editorially rather than for soundness. And `x-telo-step-context` is now the
legacy spelling: it is read forever (published artifacts carry it, and no
migration entry can synthesize a `$ref`) but a new step body is declared by
pointing at the fragment, which the derived `x-telo-fragment: Step` stamp makes
recognizable with no marker to remember.

A forward-declared `requires.telo` lower bound is now its own verification state.
Adopting new syntax means declaring the release that will carry it, so on that
commit the edge names a version npm does not have — and spawning
`npx @telorun/cli@<unpublished>` there produced an `ETARGET` wrapped in install
noise, reported as "could not run", indistinguishable from being offline. The
registry is now asked before any edge runs, such an edge is never spawned, and it
is reported as `pending` alongside the latest published version (which is what
makes a typo'd bound visible). Informational in `telo release check`, fatal in
`telo publish`, where npm has already published and the floor must exist.
