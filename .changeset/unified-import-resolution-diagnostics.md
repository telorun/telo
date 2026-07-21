---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
---

Surface broken `imports:` sources as structured diagnostics through one shared
code path, so every host reports them identically.

Import-resolution failures were collected into `LoadedGraph.errors` as raw
`Error`s with no diagnostic code. Each host assembled its own diagnostic list
from the graph, and they drifted: the CLI re-threw the first error as a bare
message, while the VS Code extension dropped the channel entirely — a manifest
with an unresolvable import showed **no** in-editor diagnostic.

The channels split cleanly across two layers:

- The analyzer owns the raw conversion: `importResolutionDiagnostics(graph)`
  turns `graph.errors` into coded `AnalysisDiagnostic`s — `INVALID_IMPORT_SOURCE`
  for a source no transport can ever resolve (e.g. `not-found@whatever`) and
  `IMPORT_UNRESOLVED` for a well-formed ref that failed to fetch (404, missing
  file). Each adopts the `{ filePath, path: "imports.<alias>" }` shape
  version-reconciliation diagnostics already use, so the shared `findPositions` /
  `resolveRange` routing anchors them on the offending import line with no
  host-specific code.
- `@telorun/ide-support` owns the presentation policy:
  `assembleGraphDiagnostics(graph, analysis)` folds parse, version, import, and
  static analysis into one list and partitions out the cascade that would bury
  the real cause — the analysis diagnostics of any file that failed to parse
  **or** whose import failed to resolve (both have unreliable kind resolution).
  It returns `{ diagnostics, suppressed }`: hosts surface `diagnostics` and may
  render `suppressed` dimmed. The compromised-file set is exposed on its own as
  `compromisedFiles(graph)` so the multi-closure telo-editor applies the exact
  same policy the single-closure VS Code host does — the two show identical
  info. The CLI, VS Code extension, and telo-editor all route through this one
  source, so a channel can never again be surfaced by some hosts and forgotten
  by others.

`GraphLoadError` gains `alias`, `source` (the author-written import string), and
`sourceLine` to support precise anchoring and messages that quote what the
author wrote rather than a resolved `file://` URL.

`telo check` now renders import-resolution failures as coded diagnostics
alongside everything else — with a file:line:col and code — instead of throwing
the first as an uncoded message, and suppresses the secondary kind-resolution
cascade a broken import would otherwise trigger.
