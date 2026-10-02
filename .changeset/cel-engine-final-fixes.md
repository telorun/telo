---
"@telorun/cel": minor
---

Two defects in `@telorun/cel`'s evaluation, and the gates that could not see them.

**A value that must be awaited is refused at every door it comes through, and the doors are now a named
list.** A thenable was refused at an
activation read, at a host implementation's result, at dispatch and at the program's exit — so `x.p`,
`x.p + 1` and `[x.p][0]` were `async_value_unsupported`, while **`[x.p]` answered a list holding the
promise** and `{'k': x.p}` a map holding it. The guard sat where the value was later used rather than
where the read answers, which is one character short of the shape a manifest actually writes
(`!cel "[resources.x.status.p]"`). The check now sits in the member read itself, covering `a.b`,
`a['b']`, `.?` and `[?]`, and an absent-or-awaited optional is refused rather than wrapped as present.

The same guard was missing at **every form that binds a value into a body**, and there it was worse than a
leak: `xs.all(e, true)` over a host list holding a promise answered **`true`** — a wrong answer decided
about a value nothing touched. The element is now refused where it enters a body, in the one place a
comprehension's meaning lives, so both backends inherit it; and with it the value `cel.bind` binds, an
optional's held value entering `optMap` / `optFlatMap`, and list membership, which reads every element
without binding one. One refusal serves all of them (`asyncValueRefused`), so no door answers with a
different code or wording, and the forms are **data** (`BINDING_FORMS`) held to a probe per form, each
probed under a constant predicate and a reference comparison both — a tenth binding form cannot be added
unguarded.

**That refusal is terminal**, which is what makes it worth anything: carried as an ordinary CEL error it
was discardable, so `[P, 2].all(e, false)` answered `false` and `[P, 2].exists(e, true)` answered `true`,
each decided off the one element the engine could read. The element is now judged where it is **bound**,
before the body runs, and the comprehension ends there whatever a later element would have decided. An
ordinary `no_such_key` still short-circuits exactly as before — it is a fact about one datum, where a value
that must be awaited says the host handed the engine something it cannot evaluate at all.

A container is deliberately not walked: a thenable is refused where it becomes a value the engine reasons
about, so `size(xs)` and `xs + [3]` carry it along while every way of reading the element out is refused.

**A dotted chain whose ROOT alone is declared is read as the declared name.** The split over declared
names started at two segments, so such a chain fell into the activation's prefix search: an activation
holding both `a` and the literal key `"a.b"` answered the undeclared key at evaluation where the check
had typed the declared name — the one outcome that split exists to prevent. The root now counts as a
prefix, and where any prefix is declared the search never runs. The checker keeps its ordinary select
path for a root-only split, because the nullable-access rule is a fact about an expression's shape
rather than about which name it reads.

**The conformance drivers gained the two things they were not asking.** An excluded row that checks
clean is now held to the **recorded type** — an exclusion excuses a verdict and pins no type, so that
branch compared nothing at all, and a fabricated row declaring `1 + 1` to check as `string` passed the
gate. A per-group `typeDiffers` names the rows whose type differs, exactly as `offsetDiffers` names an
offset. And an exclusion matched on a fact about a row's input (`disable_check`, cel-spec's value read
with the check turned off) now has to be **true of the row**: it applies only where this engine really
refuses at check, which moved nine rows cel-spec never contradicted into plain agreement and one row to
the container reason that is its actual cause. Deferring a row to the check seam requires a correction
over there rather than merely an exclusion.

Also: the whole package type-checks under one gate (`check:types` over `src`, `tests` and `conformance`,
where only `src` was covered before, and the conformance driver held a real error); unit tests for the
converting lossy comparison, `int(double)` at **both** int64 extremes and a duration's
`getMilliseconds` component, which only the replay pinned; and `value-equality.ts` now documents the
rule it implements rather than the exact comparison it replaced.

Still nothing consumes the package: `@marcbachmann/cel-js` serves the whole repository, and no manifest,
consumer or module changes.
