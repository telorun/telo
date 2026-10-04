---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
---

The analyzer's CEL half now runs on `@telorun/cel`; `@marcbachmann/cel-js` is no longer a dependency of it. The editor's CEL symbols read the new engine's types with it, so completion and hover answer what `telo check` resolves, and the engine bundle declares `@telorun/cel` among the workspace packages it inlines.

**A module's own names are NAMESPACES on the environment a site is read against.** Resolution used to be a rewrite applied to a parsed tree after the fact; a qualified call is now a node of its own, produced as the expression is READ over the name set, so every walk — access chains, the unused-declaration pass, the durable-nondeterminism pass, a callable's derived flags, a rule's condition — sees the resolved shape instead of re-deriving it. A namespace is declared **open**, with each reachable callable's declared result and no parameter list: whether a call reaches a function at all, and whether its arity and arguments fit, rest on the export gate, the dependency edge and a JSON Schema per parameter, which is `FUNCTION_UNRESOLVED` / `_NOT_EXPORTED` / `_NOT_CALLABLE` / `_ARITY_MISMATCH` / `_ARGUMENT_MISMATCH` — the analyzer's own verdicts, withheld by the engine by construction rather than suppressed after the fact.

**A name a module declares that CEL cannot read as a namespace is filtered, not refused.** A module name, an import alias and a library's `metadata.name` are YAML scalars nothing lexes where they are written — which is what `INVALID_NAME` / `INVALID_TYPE_NAME` exist to report — so a set reaching the engine routinely holds `my-module`, and the engine refuses such a set whole. Letting that throw would turn one reportable name into a crash losing every other diagnostic in the file.

**Reading never throws and never discards what it read**, so a `try { parse } catch` is now a check for one ranged diagnostic, and a scalar an author is mid-way through typing keeps its longest-prefix tree. Three verdict MESSAGES are the engine's own words now, with the same codes: an undeclared field reads `"dbb" is not declared here (declared: db)`, an operator with no overload `no "+" is declared over int, string`, and a repair the checker builds writes CEL's own string quoting (`a.b.startsWith("x")`).

**A branded CEL value is a plain object, so two structural walks stopped asking the prototype.** `precompileDoc` and the plain-literal decoder rebuilt a container from its entries, which drops the symbol a duration, a uint or a timestamp carries its brand under — silently turning a decoded duration into a pair of numbers — where the class instance they were written against came back untouched. Both now ask `isCelRecord`.

`steps` is registered as a closed record rather than a named type with an `in` operator of its own, since a record is a map with named keys and the standard library's `K in map<K, V>` already answers `'<step>' in steps`.
