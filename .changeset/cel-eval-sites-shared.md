---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/templating": minor
---

"Where is CEL evaluated" is one reader, and `!literal` declares that it produces
a string.

The rule had two halves in two places: `x-telo-eval` paths in `eval-paths.ts`,
and the regions that cover their contents (`x-telo-context` /
`x-telo-step-context` / `x-telo-error-context`, and a step body) in
`validate-cel-context.ts`. Every consumer needed both and combined them itself —
including the editor, whose answer is a claim that `telo check` will accept what
it writes. It read the annotation half alone, so a predicate sitting inside a
region (`Run.Choice`'s rows, an `Http.Api` route's `returns:` entries) offered no
way to write the expression the field exists to hold. The region half moves
beside the annotation half, re-exported from its old home, and both are read
through `celEvalSites` / `mergeCelEvalSites` / `celEvalModeAt` — which the
analyzer's own `CEL_IN_NON_EVAL_FIELD` and `OBSERVED_STATE_IN_STARTUP_FIELD`
checks now ask instead of combining the pieces themselves.

Three CEL mistakes that reached the runtime unreported now fail `telo check`.

An **undeclared root identifier** (`!cel "fff"`): cel-js types an unknown name
as `dyn` and accepts it, so the one CEL mistake with no static report at all was
the simplest one. Member access on a KNOWN root was already covered, which is
why a typo one level in was an error and a typo at the root was not. Reported as
`CEL_UNKNOWN_IDENTIFIER`, and only where the environment is complete: a kind
document's `examples:` and rule conditions are written for the scope of whoever
instantiates the kind, and CEL below a nested inline `{ kind }` belongs to that
kind — the two boundaries the non-eval-field check already draws.

**`variables` / `secrets` typed per declaring module**, as `ports` and `module`
already were. A resource document does not carry those blocks, so typing them
from the analyzed manifest alone left every ordinary resource with an open map
and no check, while `ports.<typo>` one line away was an error. They are read
from the resource's own block, then its `metadata.moduleGlobals` stamp (a
library's own, which must win over the consuming application's), then the entry
module's doc.

**The expression's type against the field's** — this check already existed and
could not fire, because an untyped `variables` made every expression over it
`dyn`. `when: !cel "variables.env"` now reports that it returns a string where
the field expects a boolean.

Also modelled: `inputs` is in scope beside `steps` wherever a step body runs.
The step engine always provided it and nothing declared it, which went unnoticed
while the step context stayed open. Left OPEN rather than typed from the kind's
`inputType`: closing it would newly reject reads of arguments a contract does
not spell out, which is a separate decision.

`celCompletions` joins `buildCompletions` on `@telorun/ide-support`'s surface.
The document-plus-cursor entry point is the wrong shape for a host that edits a
CEL body directly in a field and therefore knows the site's address already;
without it that host would model the scope itself, which is the thing the
completion list is supposed to be a claim about.

`!literal` declared no `producedType`, which put it in `!cel`'s category —
produces whatever the slot says. It does not: it returns its source verbatim, so
its type is a constant of the tag, exactly like an embed's. Declaring it keeps
the tag off slots text cannot satisfy and makes a `!literal` at one a static
failure through the ordinary schema check, where it previously passed
`telo check` and failed at runtime.
