---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Three shapes that passed `telo check` and then behaved differently at run, all
found while answering a report about composing kinds.

**A template body's `!ref` now reaches the declaring module's own resources from
a step, as it already did from a reference slot.** Both sites stamp
`{kind, name}`, and the kind was left empty for anything that was not a sibling
entry. That was survivable at a reference slot — Phase-5 injection dispatches by
name and recovers the kind, so `client: !ref apiClient` worked — and fatal at a
step's `invoke:`, where `ensureKindRef` reads an empty kind as a malformed inline
declaration and boot fails with `Resource must have 'kind' property. Got:
{"kind":"","name":"…"}`. So the same reference resolved at one site and died at
the other, with nothing static reporting either. The kind is now resolved from
the siblings first and then from the declaration the name reaches in the
enclosing scope; it stays empty only for a name that reaches nothing, which is a
genuinely unresolved reference the existing errors own.

**A module's own name resolves its own kinds.** `<module>.<Kind>` IS the
canonical identity the registry keys on and every diagnostic prints, so an author
reading an error copies that spelling back into the manifest. The analyzer
resolved it and the kernel registered only `Self` plus imported aliases, so it
passed `telo check` and failed at boot with "no module imported with alias
'<name>'". Both the root context and every import's child context now register it
beside `Self`.

**A missing required field inherited from a parent says where it came from.** A
child that `extends` and declares no `base:` is authored against
`merge(parent, own)`, so the parent's `required` stays on the CHILD's surface and
a kind written to wire that field internally still demands it from its consumer.
`base:` is what narrows, and nothing in "is missing required property" pointed
there — three steps to discover a dead end. The hint names the inherited fields
and the parent, derived from the definition rather than parsed out of the
validator's prose.

All three are pinned in `tests/check-run-agreement.yaml`. The first two assert a
clean check AND a clean run, since the fix is that the spelling works rather than
that it is reported.
