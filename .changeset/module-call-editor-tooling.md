---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
---

Module calls are first-class in the editor. Completion after `Self.`, a module's own name or an import alias offers the functions that call can name, each with its signature; hover on a call shows the function's signature, description and derived determinism, naming the chain to a non-deterministic or host-backed leaf; the new `buildSignatureHelp` highlights the argument being written; go-to-declaration jumps from a call to the function resource (and from its alias to the import); and a call's receiver is coloured as a namespace. Renaming a function renames its calls, and renaming a named shape proposes a type-level name — `buildRename` takes the analysis, and `ManifestAnalysis.nameLevel` answers whether a resource's name denotes a type or a value.

`CelScope` gains `moduleFunction` and `moduleFunctionsOf`. The module graph draws each module call as a `holds` edge from the calling resource to the function (`slot: cel`, the function named in `call`), and a shape a contract or signature names (`params[0].schema: !ref Money`) is a `schema` reference in the call graph, so it is a `shape` edge rather than an untyped one.
