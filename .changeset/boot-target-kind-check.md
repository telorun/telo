---
"@telorun/analyzer": minor
---

A reference is now checked against an abstract constraint even when the analysis
holds **no implementation of that abstract** — which is exactly the case where
the check was needed and never fired.

`checkKind` skipped a slot whenever the target abstract had no loaded subtypes,
on the grounds that partial context cannot tell a mismatch from a missing
dependency. But that leniency is about the CANDIDATE, not about the population:
an application whose imports declare no `Telo.Runnable` is an application whose
boot targets are all wrong, and every one of them passed. `targets: - !ref x`
naming an invocable — a `JS.Script`, a durable workflow — reported nothing and
then failed at boot with `Resource not found for invocation: undefined`.

The leniency now turns on whether the candidate's own ancestry is fully loaded —
asked of the registry, which owns those edges in both directions
(`parentsOf` / `ancestryResolved` beside `getByExtends`). Every kind the
candidate names through `capability:` / `extends:` resolving means what it
implements is settled, so reaching the target or not is a verdict; a missing hop
still skips, for an abstract target and a concrete one alike.

A candidate the registry never saw cannot be judged on what it implements, so it
stays lenient. Whether its NAME is resolvable is a separate question, asked of
the alias resolver rather than of the string's shape: a qualified kind whose
prefix names no import in scope (`NotAnAlias.Script`) is a bad name and is still
reported, while one reached through a DECLARED alias resolves even when the
target's definitions are absent, and a canonically-written kind the registry
holds is identified without any alias at all.

With no implementation list to suggest, the message says what the kind IS
instead — `'javascript.Script' does not implement 'Telo.Runnable' — it declares
'Telo.Invocable'` — which points at the repair, an invoke step rather than a
boot target.
