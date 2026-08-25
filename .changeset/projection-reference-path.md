---
"@telorun/analyzer": minor
---

`x-telo-schema-projection` gains a **`reference:` path** — how an entry whose
keyed field holds a `!ref` rather than a value from the closed vocabulary
projects.

The map is keyed on the field's value and a reference is not a key, so such an
entry fell through to nothing. The path is declared as data by the backend
(`from` names the target field to read, `keyword` the schema keyword its values
become, `base` / `baseFrom` where the node's own type comes from), which is what
keeps the analyzer from learning that the domain exists: nothing in it says SQL,
column or enum, and a backend that declares none projects exactly as before.

A deliberate exception to the projection's lossiness. Length, precision and
collation stop at the boundary because the database enforces them; a domain
crosses because it *is* the type at the granularity a consumer acts on.

Two reader changes follow. `x-telo-schema-map` is now found on a **branch** of a
union, peeled the way the ref-slot reader already peels one — and so is the
`enum` the map's completeness is checked against, which would otherwise have
silently stopped being checked. An entry whose reference cannot be read is
reported (`entry-reference`) **and projected OPEN** rather than dropped. The two
failures are not the same failure: an unmapped value is a gap in the kind's own
vocabulary, so there is no entry to speak of, while an unreadable reference names
an entry the declaration plainly has and only leaves its type unknown. Dropping it
made the projection deny the entry exists, so a row naming it was told the
property is not allowed — blaming the row for the reference's mistake.

`no-projection` is split into `no-projection` / `no-projection-map` /
`no-entries`. One message ("declares no 'x-telo-schema-projection'") was printed
for a kind that declares one whose key field carries no map, and for a declaration
whose entry collection is simply absent — accusing the wrong author of the wrong
omission in both. `readProjectionRef` reads the unresolved `!ref` sentinel too,
which is exactly the shape present when a projection failure is reported and was
previously named `<unnamed>` in it.
