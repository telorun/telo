---
"@telorun/analyzer": minor
---

Draw a library root's exports instead of boot targets it cannot have.

The module graph stamped `targets` on every root, empty or not, on the premise
that a boot list is something a root always has. That is true of a
`Telo.Application` and false of a `Telo.Library`, where `targets:` is forbidden
— so a library was drawn a branch, and an add affordance, for a field it may not
declare.

A library root now lists what it exports: `exports.kinds` and
`exports.resources`, as two arrays rather than one, because a kind and an
instance are different things to export — a kind lets an importer construct its
own, an instance is one the library already built and hands over. Entries are
carried as written, so an `Alias.Name` re-export reads as the author typed it,
and an entry that resolves to nothing keeps its row: a name the library lists
but nothing provides is a fact about the manifest, and dropping it would hide
the one export that is broken.

Each exported INSTANCE gets an edge to the node it names, classed `holds` — the
module owns it and hands it out, and control never transfers along that edge.
An exported KIND gets none: kinds are a separate plane, deliberately, so that
things which exist at runtime and things which do not are not drawn among each
other, and selecting a kind already rings its instances.

The new `export` row kind is not ordered. An export list is a set, so there is
no entry before any other and a "move up" would be an affordance over a
distinction that does not exist.

Export edges are minted outside the call-graph projection, which flags every
edge leaving the root as a boot target on the premise that the root has no other
slots. That premise held while `targets:` was the root's only reference; an
export reported as a boot target would claim the library starts something.

`Telo.Library`'s `exports.kinds` / `exports.resources` gain schema titles, which
is where the editor reads a branch's label from — naming them in the schema is
what keeps resource-kind knowledge out of the view.
