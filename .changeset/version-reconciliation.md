---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Reconcile module versions to one version per identity within an import graph.

When the same `<namespace>/<module-name>` is reached at multiple versions (a diamond import), the loader now collapses them onto a single version before any controller, definition, or kind is registered — fixing the spurious `DUPLICATE_IMPORT_ALIAS` and the silent last-writer-wins controller collision that two versions of one module previously caused.

- Same major → the highest version wins (a non-lossy hoist given the additive-only pre-1.0 policy), reported as a `MODULE_VERSION_HOISTED` warning on the lower-version import line.
- Different major → a fatal `MODULE_VERSION_CONFLICT`; `telo run` refuses to start and `telo check` errors.
- Same version from two sources with differing content → a `MODULE_VERSION_HOISTED` warning; identical content is deduplicated silently.

Reconciliation lives in the shared analyzer loader, so `telo check`, the kernel runtime, and the editor all resolve the same single version. `LoadedGraph` gains `overrides` and `versionDiagnostics`.
