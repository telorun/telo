---
"@telorun/analyzer": minor
---

**Peer rules** — a referrer rule may declare `peers:`, a JSON Pointer naming a
collection of the referrer to resolve, binding that collection's other entries as
`peers` and the referrer's own entry as `entry`.

A rename marker is wrong only in relation to the *other* declarations a schema
lists; an enum a column names is unlisted only in relation to the same set. A
resource rule sees one resource and a plain referrer rule sees a pair joined by
one reference, so neither can state a relation between siblings.

- **The field map decides what is a reference**, never the value's shape. A
  `{kind, name}` object is what a resolved `!ref` looks like and also what author
  data carrying two common keys looks like; the referrer kind's ref-slot paths are
  the authority, and the caller already holds them.
- **Entries bind as written, with the references inside them resolved one level**
  — a peer is the declaration where the entry is a bare `!ref`, and the
  declaration with its siblings beside it where it is not. One level only, since a
  self-referencing foreign key and a mutual pair are both cycles.
- **A peer rule evaluates once per entry**, anchored at that entry's slot path,
  and excludes `self` **by slot path** rather than by identity — by index for an
  array collection and by key for a map, which spell an entry's path differently.
- **A resolved declaration is scanned for `!cel` leaves where it is known to be a
  manifest.** `findDynamicLeaf` stops at any nested `{kind}` object, so the whole
  peer set would otherwise be exempt and a duplicate hidden behind an expression
  would compare against a sentinel and silently hold.
- **A collection is resolved once per referrer and pointer**, shared by the
  evaluation and the exercised check. Re-resolving per entry is quadratic at the
  editor's keystroke-time analysis, and the rule budget then reports a correct
  rule as a defective one.
- **Strict half at the declaring kind**: `peers:` must name a collection the
  `referrer:` kind declares whose items are, or contain, a reference, and it
  requires `referrer:`. Both are `REFERRER_RULE_INVALID`.
- **Coverage variance is reported both ways**: a peer that resolves to nothing, or
  an absent collection, is `REFERRER_RULE_SKIPPED`; a rule whose peer set was
  empty everywhere is `REFERRER_RULE_UNEXERCISED`, which is what a typo in
  `peers:` looks like from outside.

- **The analyzer's own binder environment lives beside the binder** —
  `analyzerPeerBinder` / `analyzerPeersTarget`, the `analyzerContractScope`
  precedent — rather than as forty inline lines of the analysis pass, which had
  come to use two different field-map accessors for one question.

A rule's `condition:` must now carry the `!cel` tag, across both rule families.
The readers stay lenient and a bare string still runs, but untagged the expression
is not CEL to the editor's colouring, completion or hover — so it is reported
rather than lost silently.

**A `!ref` is no longer read as a dynamic value.** Both rule families skip a
subject whose read nodes hold a value only known at creation, and the predicate
tested `__tagged` alone — which every tagged sentinel carries, `!ref` above all.
A column whose `type:` holds a reference therefore switched off every rule reading
`self.columns` and reported "the value holds a CEL expression" against a manifest
containing none. `dynamicNode` classifies by engine and the diagnostic names the
tag it actually found (`an !include-bytes embed`), so the recursive walk and the
peer binder's own top-level scan cannot disagree about what a reference is.
