---
"@telorun/analyzer": minor
---

`x-telo-referrer-rules`: a kind declaring, as data, what must be true of whoever
references one of its resources — the mirror of `x-telo-resource-rules`, which
relates the fields of one resource and so cannot reach across a reference.

Declared by the kind that HAS the requirement rather than the one that must
satisfy it, which is what makes it sound: written on the referring side, a rule
must name the target kind as a string, and a manifest spells a kind with the
alias its own author imported it under — so such a rule silently passes on every
manifest that picked a different alias. Declared on the referenced kind, the
subject is chosen by the reference itself and no kind literal appears there at
all. It is also the only direction that scales: a third-party mount carries its
own requirement without the server kind learning it exists.

In scope: `self` (the referenced resource) and `referrer` (the one that reached
it). The optional `referrer:` filter names a kind in the alias-qualified grammar
`extends:` uses, canonicalized in the declaring scope; a filter that resolves to
nothing is reported at the kind, since it would match nothing and leave the rule
inert. Violations are reported on the referrer at the slot path that reaches the
resource, under `REFERRER_RULE_VIOLATED` with the author's own code in
`data.rule`; `REFERRER_RULE_UNEXERCISED` reports a rule nothing ever matched,
which is what a typo in `referrer:` looks like from the outside.

Polarity, the host-backed and non-deterministic refusals, the condition cache and
the 50 ms budget are shared with resource rules rather than reimplemented.
Guide: `docs/extend/referrer-rules.md`.
