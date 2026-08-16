---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/templating": minor
---

A step's `retry:` is implemented in the step leaf, where all four dispatch
branches pass through. It was previously handed to `ctx.invoke` on one branch and
read by nothing, so a `!ref` step — the dominant shape — silently got a single
attempt however many it asked for. It takes `Http.Request`'s field names
(`attempts`, `initialDelay`, `factor`, `maxDelay`, `jitter`), because two
spellings of backoff in one standard library make the word change meaning with
where it is written; `delay` survives as the older duration-string spelling, and
a malformed one throws instead of falling back to a silently different backoff.
A domain failure is retried; a cancellation and a contract violation
(`ERR_INPUT_INVALID` and its siblings) are not — the latter is a property of the
manifest, so every re-attempt fails identically and the budget is spent between
a typo and the message naming it. `InvokeByNameOptions.retry` is removed: the
leaf owns the policy now, and a key nothing reads is a second inert way to ask
for it.

A resolution failure — `ERR_RESOURCE_NOT_FOUND`, `ERR_RESOURCE_NOT_INVOKABLE` —
joins the contract errors as unretryable: a misspelled target does not become
spelled correctly after eight seconds of backoff.

`InvokeStepState` gains `invokeCtx`, so the wait between attempts is cancellable.
Every other point in a sequence already was — the kernel refuses a dispatch
reached after the tree was cancelled — but a backoff is time inside the leaf,
where that gate cannot see it and the ambient context store is deliberately not
on the SDK surface, being one runtime's mechanism. The failure that caused the
wait rides on the cancellation as `data.pendingFailure` rather than being lost
to it.

A dispatch site is now one shape the analyzer owns —
`telo://manifest#/$defs/InvokeStep`, `{ invoke, inputs, when, retry, name? }` —
referenced by every `Run` step array and by an Application's `targets:` instead
of being hand-restated by each composer. The runtime always had exactly one
(`InvokeStep` / `executeInvokeStep`); only the schema half was duplicated, and it
had drifted, which is why `retry:` worked in a sequence step and was a schema
error one line away at boot. Boot targets now accept it, and the boot runner
forwards the whole entry rather than rebuilding it field by field, which is what
had been dropping the field it did not know about.

The fragments live in `@telorun/analyzer` because the editor validates in a
browser through it and the analyzer cannot depend on the kernel; they moved off
`@telorun/templating`, which no longer exports `ResourceRefSchema`,
`ManifestRootSchema` or `MANIFEST_SCHEMA_URI` — import them from
`@telorun/analyzer` (or the kernel's re-export). They are expanded in place at
load — for every consumer, ungated: they are the analyzer's own closed set
rather than authoring sugar, and the editor's schema resolver handles
document-local refs only and throws on anything else. They are merged with their
siblings so a `$ref` composes on draft-07, stamped with the fragment they came
from, and the set is deep-frozen so an embedder cannot rewrite it in place.
`builtins.ts` embeds an expanded copy, since it is not a manifest and never meets
the loader.

That stamp replaced `x-telo-retry`, which is removed: the analyzer reports
`LIVE_VALUE_RETRIED` where a `live` value is passed to a
dispatch that may repeat — a stream is consumed by reading, so a re-attempt would
pass nothing. Neither half names a kind: the value's liveness comes from its
value type, and the re-attempt from the shape the field was declared with, which
also says where the budget is — a policy object's `attempts` or a bare count —
so the deprecated scalar spelling is covered with no special case. Read on the
step and on the invoked target alike, and only when the budget is a statically
known non-zero. The chain root resolves against the enclosing kind's own
`inputType` as well as the step map: the shape a live value takes when it was
produced outside the resource forwarding it.

CEL's `slice` is overloaded by parameter type, so a wrong receiver is rejected.
It returns `dyn`: cel-js refuses a `dyn` parameter variant alongside concrete
ones, and concrete returns would resolve an untyped receiver to whichever
overload registered first and mistype it — slicing an untyped byte buffer came
back `string`.
