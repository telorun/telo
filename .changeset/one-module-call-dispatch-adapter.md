---
"@telorun/templating": minor
---

**One adapter turns a host's dispatch table into the engine's namespace seam.** A module function's arguments are a host boundary, so they cross `hostValueOf` — the rule this package already documented and pinned on the compile path. The analyzer kept a second adapter for the table it binds while evaluating a rule condition or a pure function body at `telo check`, and that one called the bound function with the raw values: a map literal written at a call site arrived as the value domain's map container under `telo check` and as a plain object at run. The two halves disagreed about what one manifest means, by construction, in the direction nothing reports — a callable's parameters are AJV-checked against its declared `params`, so the container was refused for a property its author had written. `namespaceDispatchOf` is now exported from here and is the only adapter either host reaches the seam through; it is pinned directly, in both the shape the analyzer holds a table in and the shape a compiled value does, rather than only through one caller.

`celNamespaceNames` was duplicated the same way — identical logic in both packages, where this one owns the name set it filters. The analyzer re-exports it instead.

**An evaluation-time rule failure is anchored only at an import this workspace owns.** The anchor fell back to a dependency's own `imports:` entry whenever no entry-owned import named the declaring module — a line the reader neither owns nor can change, and not where the defect is either, which is the failure this anchoring was introduced to remove. With no entry-owned import naming the module the diagnostic now stays on the rule's own declaration, which at least names the kind at fault.
