---
"@telorun/ide-support": minor
---

Add `buildHover`, `buildSemanticTokens`, and `buildDefinition` to the
host-agnostic IDE surface, mirroring `buildCompletions`.

**Hover.** `buildHover(text, line, character, registry, docs?)` resolves the
cursor with the same `resolveNodeAtPosition` machinery as completion and returns
a `HoverResult` (markdown + source range): a `kind:` value renders the
definition's module, capability, schema title/description, and input/output
types; a prop key or field value renders that field's schema `description`,
`type`, `enum`, `default`, and `x-telo-ref` constraint; a structural root key
(`imports`, `targets`, `variables`, …) falls back to built-in docs.

**Semantic tokens.** `buildSemanticTokens(text, registry, docs?)` returns
registry-aware `SemanticToken`s — a `kind:` value that resolves to a known
definition is a `type`, a `capability:` value is an `interface`, and a `!ref`
target is a `variable` (colored from the AST because a `!ref` after a `key:` is
claimed by the bundled YAML grammar before a TextMate pattern can reach it); an
unresolved kind gets no token, pairing with the analyzer's `UNDEFINED_KIND`
diagnostic. `SEMANTIC_TOKEN_LEGEND` is exported for hosts to register against a
stock legend.

**Go to definition.** `buildDefinition(text, line, character, graph, currentFilePath, docs?)`
resolves the `!ref` under the cursor to its target resource's definition,
returning a `DefinitionResult` (`{ uri, range }` at the target's `metadata.name`).
It mirrors the `resolveRefSentinels` grammar — a bare name or `Self.name` is a
local resource in the current module; `Alias.name` is an exported instance of the
module the import points at, resolved through the graph's `importEdges`. The VS
Code extension registers a `DefinitionProvider` (ctrl/cmd-click) backed by it,
caching the `LoadedGraph` per file for the cross-module lookup.
