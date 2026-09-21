---
"@telorun/analyzer": minor
"@telorun/studio": minor
---

Open a templated kind's body as a canvas of its own

A templated kind in the module drawer now opens its body as a module graph: each `resources:` entry is a box with its own rows, ports and edges, references between entries are edges, and the definition's `targets:` (or its single `run:` target) mark the entries it starts. Edits on that canvas write back into the definition — an entry's rows, slots and wires into its `resources:` entry, a resource created for a slot as a new sibling entry, and "Start at boot" into `targets:` (a lone `run:` becomes `targets:` once a second entry is added). The analyzer exports `templateModule`, which lays a definition's body out as a module for `buildModuleGraph`. A module resource the body references is drawn read-only (ownership `enclosing`), and a slot forwarding `self.<path>` is an edge to a node standing for what the instance supplies (ownership `forwarded`). A write to a name the body declares twice is refused with an error rather than sent to the first entry.

A boot target written as an inline invoke step now marks the resource it invokes ("invoked at boot", with its position, step name and `when:`), and the boot toggle on such a resource removes that entry instead of appending a duplicate `!ref`.
