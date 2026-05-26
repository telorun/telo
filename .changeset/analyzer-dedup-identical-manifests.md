---
"@telorun/analyzer": minor
---

Tighten `StaticAnalyzer.analyze()`'s position-info contract and fix two `DUPLICATE_RESOURCE_NAME` reporting issues exposed by the telo editor.

- **Contract.** `analyze()` now requires `metadata.source` (non-empty) and `metadata.sourceLine` (number) on every non-system manifest. Production callers — the `Loader`, `flattenForAnalyzer`, the telo-editor's `emitDocsFor`, the VSCode extension — already stamp these. Programmatic callers (tests, ad-hoc scripts) should pass inputs through the new `withSyntheticPositions(manifests, source?)` helper before calling `analyze()`; a missing position now throws a clear error instead of silently producing wrong diagnostics.

- **Pipeline-echo false positives** — same physical doc emitted twice through an analyzer host's pipeline (e.g. a workspace file reachable from multiple modules) — now collapse cleanly. The dedup keys on `(kind, name, source, sourceLine)`, so identical docs are deduped while two textually-distinct duplicates in the same file (different `sourceLine`) keep separate fingerprints and still trip the diagnostic.

- **Squiggle placement on real same-file duplicates.** When a user textually duplicates a resource in a single file (same kind + name, different `sourceLine`), the diagnostic now carries an explicit `range` pointing at the duplicate's line. Editor hosts that resolve diagnostic positions via a `${file}::${kind}::${name}` map otherwise collapse all instances onto whichever one the map happened to record — the explicit `range` short-circuits that lookup so the squiggle lands on the new duplicate, not the original.

The new helper is exported from the package root:

```ts
import { withSyntheticPositions, StaticAnalyzer } from "@telorun/analyzer";

const diags = new StaticAnalyzer().analyze(withSyntheticPositions(manifests));
```
