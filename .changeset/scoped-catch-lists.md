---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A `catches:` list can cover a whole scope, and coverage is judged at the dispatch site.

**`x-telo-catches-for` takes the empty pointer**, naming the resource the list is written
on rather than a sibling field holding a handler — the spelling
`x-telo-schema-projection-from` already uses for the same "this declaration, not one it
references" meaning. Such a list owes coverage of nothing on its own; it contributes to
every site it encloses, and its own denominator is everything its resource drives,
transitively.

That denominator is deliberately NOT `throws: { inherit: true }`. `inherit` is a
declaration that a kind's union is the union of what it dispatches, and a kind that has
not made that claim must not have it inferred — one holding a `call` ref it catches
internally would silently gain codes it never lets escape. It is also forbidden on a
`Telo.Service` and a `Telo.Mount`, rightly: what a router *renders* is not what a router
*throws*. So the annotation carries the claim, where it is used.

**`x-telo-ref` gains `throwsThrough: true`** for a slot whose target's throws surface
through the declaring resource although control does not transfer through the slot itself —
`Http.Server.mounts[].mount` is a `dependency`, and a route's throw is still the server's
to render. Declared by the kind that holds, because only it knows this; following every
`dependency` edge instead would drag a connection's throws into a router's denominator.
It is one fact with two consequences, and they are the same fact: the edge the throws
closure crosses is the edge a catch scope encloses through.

**Coverage is asked once per dispatch site**, over the site's own list, its resource's
scope list, and every scope enclosing that resource — so `UNCOVERED_THROW_CODE` and
`UNBOUNDED_UNION_NEEDS_CATCHALL` no longer fire on a route that declares no `catches:`
under a router that renders everything. Left per-list they were not a missing check but a
false one, firing on precisely the manifests scope lists exist to enable.
`UNDECLARED_THROW_CODE`, `error.data` typing and `CATCHALL_NOT_LAST` stay per list, each
against that list's own denominator.

**Across several enclosing scopes it INTERSECTS.** Coverage claims a throw cannot escape
unrendered, so it holds only where every path to the site renders it: a router mounted on a
public server with a catch-all and an internal one without is covered on one path and bare
on the other, and unioning the two asserted full coverage while the internal server answered
with the built-in envelope. A resource with no encloser contributes nothing rather than
everything — treating "no paths" as "all paths agree" would assert coverage no list gives.

**`throwsThrough` gets a strict half.** It is read as `=== true`, so a typo or a quoted
`"true"` silently meant absent — and absent stops a server's list enclosing its mounts, so
every route under it reports as uncovered with nothing naming the cause. The structured
`x-telo-ref` object is now closed as well (`X_TELO_REF_UNKNOWN_KEY`,
`X_TELO_REF_INVALID_THROWS_THROUGH`), for the reason its token sets are.

**A `with:`-scoped declaration is now checked.** Scoped resources are not in the flat
manifest set, so every check in the throws pass skipped them: a scoped `Http.Server`'s own
catch list went unverified AND its coverage reached nothing it encloses. Standing a server
up around a test is exactly that shape, so the sanctioned pattern was the one the pass
could not see. They are discovered through the shared manifest visitor rather than a second
scope walk, which now carries each declaration's own path (`with[0]`) alongside the
visibility pointers — those name where a scoped name may be REFERENCED (`/steps`), never
where it is DECLARED, so a prefix derived from one points into the wrong field. A scoped
diagnostic routes through its owner, because position lookup finds top-level documents by
`(kind, name)`, while the message still names the scoped resource.

**`error.data` typing worked for no HTTP catch entry at all.** It read `entry.body`, while
an HTTP entry keeps its body at `content[<mime>].body`, and it matched only `${{ … }}`
strings while the formatter normalizes every expression to a `!cel` tag. Both are repaired,
so a misspelled field under a code's declared `data` payload is reported at every rung.

**Rule 8 is enforced statically.** `throws:` on a capability with no catchable dispatch
(`Telo.Service`, `Telo.Mount`, `Telo.Provider`, `Telo.Type`, `Telo.Sink`) was refused by
the kernel at `create()` and accepted by `telo check` — a manifest that could not boot,
passing. It is now `THROWS_ON_NON_DISPATCH_CAPABILITY` on the declaration.

**Schema-failure prose, three repairs.** A union branch failing a `const`/`enum` is no
longer a candidate reading at any depth — those keywords exist to discriminate, so a
mismatch is positive evidence of the wrong branch, and the depth tiebreak inverted exactly
there: a definition declaring a forbidden key was reported as `/capability must be equal to
constant`, naming neither the key at fault nor a branch the value could ever have been. A
`false` schema and a `not` now have prose of their own rather than AJV's text about the
schema. And `ajvErrorToPath` decodes RFC 6901 escapes, so a diagnostic about a content map
(`application/json`) anchors on that key instead of falling back to its parent.

**`x-telo-schema-from` reports like a schema.** Its aliased-kind branch validated the
author's value raw while its sibling-reference branch substituted CEL placeholders first, so
one annotation meant two different things depending on which branch resolved it — a `when:`
typed `boolean` accepted a `!cel` at an inline slot and rejected the identical expression at
a slot anchored on the carrier declaring that very shape. Issues are also anchored at the
offending node inside the value rather than all on the slot, which for an array-valued slot
put every entry's complaint on one line.
