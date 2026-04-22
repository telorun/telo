---
"@telorun/ide-support": minor
---

New package. Editor-host-agnostic IDE support for Telo manifests: `buildCompletions(text, line, character, registry)` for completion providers and `normalizeDiagnostic(diag, ctx)` for converting analyzer diagnostics into a host-ready shape with resolved range, severity, and structured `{ kind: "replace-kind", replacement }` suggestions derived from `data.suggestedKind`. Intended to be consumed by both the VS Code extension and the telo-editor Monaco source tab.
