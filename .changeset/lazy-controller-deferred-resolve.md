---
"@telorun/kernel": minor
---

Controller resolution is deferred to a kind's first instantiation, matching the
Rust kernel. A `Telo.Definition` whose `controllers:` candidate list nothing in
this environment can host now registers fine and errors — naming the kind —
only when a resource of it is declared, instead of failing the whole module at
boot. This is what lets both kernels load a partially-covered module (e.g.
`console`, whose stream kinds have no Rust controller) and agree on when a
partially-covered module fails. The import/eval half was already deferred; this
moves the resolve (hostability check, cargo/source build, artifact-layer
materialization) into the same lazy thunk.
