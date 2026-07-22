---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
---

IDE completion is now driven by a read-only AST instead of line/regex/indent
heuristics, and accepting a completion replaces the whole existing node.

**Analyzer — read-only AST substrate.** The analyzer owns its own `yaml`-free
node model (`AstNode` / `AstMap` / `AstSeq` / `AstScalar` / `AstPair` /
`AstDocument`, via `parseToAst` / `documentToAst`) and a matching read-only CEL
tree (`CelNode`, `CelSegment`, `wrapCelAst`, `buildCelSegments`), so no
third-party AST type leaks through the public surface. `buildPositionIndex` /
`buildDocumentPositions` now take `AstDocument` (was `yaml.Document`), and
`LoadedFile` gains `astDocuments` — the read-only view built from the same
parse — while `documents` stays `yaml.Document[]` for the editor's mutable
model. `celSegments()` locates `${{ }}` / `!cel` regions in document offsets and
parses CEL lazily; open (unclosed `${{`) regions are recovered too.

**ide-support — AST-driven context + whole-node replacement.** `detectContext`
resolves the cursor against the AST (`resolveNodeAtPosition`): structure comes
from the parsed tree, and the cursor column only places empty-space key
positions. `CompletionResult.replaceFromColumn` is replaced by `replaceRange`
(the full source span of the value), so `kind: Sql.Co|nnection` + accept
overwrites the whole `Sql.Connection` scalar instead of leaving a `nnection`
suffix. Prop-key completion now works inside inline resources: a key position inside
`mount: { kind: Crud.Resource, … }` is completed against `Crud.Resource`'s own
schema (nearest enclosing `kind:`, path made relative to it) instead of the
outer ref slot's `{kind, name}` shape.

`buildCompletions` / `detectContext` accept an optional pre-parsed
`AstDocument[]`; hosts thread the analyzer's parse in (guarded by text
identity), falling back to a local parse otherwise.
