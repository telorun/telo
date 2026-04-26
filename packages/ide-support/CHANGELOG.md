# @telorun/ide-support

## 0.2.2

### Patch Changes

- Updated dependencies [2e0ad31]
  - @telorun/analyzer@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/analyzer@0.4.0

## 0.2.0

### Minor Changes

- c97da42: New package. Editor-host-agnostic IDE support for Telo manifests: `buildCompletions(text, line, character, registry)` for completion providers and `normalizeDiagnostic(diag, ctx)` for converting analyzer diagnostics into a host-ready shape with resolved range, severity, and structured `{ kind: "replace-kind", replacement }` suggestions derived from `data.suggestedKind`. Intended to be consumed by both the VS Code extension and the telo-editor Monaco source tab.

### Patch Changes

- Updated dependencies [e35e2ee]
- Updated dependencies [c97da42]
  - @telorun/analyzer@0.3.0
