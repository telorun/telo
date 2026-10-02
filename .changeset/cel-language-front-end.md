---
"@telorun/cel": minor
---

New package `@telorun/cel`, on the telo version line: the CEL language front end. It reads an expression into a canonical tree whose every node carries its `[start, end]` source range, writes any tree back to source that re-reads as the same expression, and answers two questions about a tree — the names it reads from its environment, and the namespaced functions it calls.

Reading never throws: a malformed or half-typed expression gives a tree for the longest prefix that read plus one ranged diagnostic, so an editor can complete a member after a dot. A qualified call (`Alias.fn(x)`) is a `qcall` node produced by a total tree pass that takes the namespace set — never by the parser, because `Alias.fn(x)` and `obj.method(x)` are one syntax — and an expression records the set it was resolved under. Macro calls stay ordinary calls. `cel` and `optional` are refused as namespaces. The five input limits (100000 nodes, 250 deep, 1000 list elements, 1000 map entries, 32 call arguments) are enforced as ordinary diagnostics.

Nothing consumes it yet: `@marcbachmann/cel-js` still serves the whole repository, and no manifest, controller or consumer changes.
