---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
---

Declaring a kind whose author marked it `metadata.deprecated` now reports a
`DEPRECATED_KIND` warning at the resource's `kind:` line, carrying the author's own
`reason` and, when one is declared, the successor.

The block already existed and was read by exactly one audience it was not written for:
the hub indexed it, while every manifest declaring the kind stayed silent. A deprecation
nothing surfaces at a use site is a note in a file nobody opens.

It is a WARNING, not an error — a deprecated kind still works, and refusing to run a
manifest over a successor recommendation gets the cost backwards. The rule is the one
every other "not the consumer's to fix" check follows: reported only for the entry's own
modules, so a library's internal use of a kind its own author deprecated is that author's
concern rather than a line the consumer is told about and cannot act on.

`replacedBy` is resolved in the DECLARING module's alias scope before it is quoted —
`Self.Thing` is how a library names its own kind and means nothing where the warning
lands — and degrades to the author's spelling when it resolves to nothing, which
`DEPRECATION_REPLACEMENT_UNRESOLVED` already reports at the declaration. No quick fix is
offered: a successor needs its own import and usually a different configuration, so it is
not a whole-value replacement for one node.

Emitted from the per-resource walk rather than a pass of its own, so it reads the kind
that walk resolved. Kind resolution is alias-aware, gate-aware and scope-dependent, and a
second implementation of it would eventually disagree about which definition a name means.

**`AnalysisDiagnostic` gains `tags`**, LSP's `DiagnosticTag` — declared whole
(`Unnecessary`, `Deprecated`) for the reason the severity ladder beside it is: it is
someone else's closed vocabulary, and a partial copy of one is what drifts. It is
orthogonal to severity, which is the point — severity says how loudly a thing asks to be
dealt with, the tag says what KIND of thing it is, and only the second can tell an editor
to strike the range through rather than merely colour it. Carried through
`normalizeDiagnostic` verbatim and mapped by each host (VS Code `DiagnosticTag`, Monaco
`MarkerTag`), never derived from the diagnostic's code — which diagnostics are
deprecations is the analyzer's to say, and a code list in a host would be a second place
to remember every time one is added.

`DEPRECATED_KIND` and the manifest-migration deprecations both carry it. A migration is a
deprecation by construction — a legacy spelling still read, and the one an author is being
asked to stop writing — so it gets the tag whatever severity its entry chose.
