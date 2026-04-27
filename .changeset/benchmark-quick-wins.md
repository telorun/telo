---
"@telorun/benchmark": patch
---

Fix `Benchmark.Suite` quick-wins:

- Pass per-scenario `invoke.inputs` through to `ctx.invoke()` instead of an empty object — the documented README pattern was previously silently dropped for scenarios that referenced an existing invocable by name.
- Declare `exports.kinds: [Suite]` in `telo.yaml` so the analyzer can validate importer references.
- Add `bun` / `import` conditions to the `./suite` export and a `main` field so the package resolves to `dist/suite.js` for Node.js consumers (was source-`.ts`-only, unpublishable).
- Stop printing "All thresholds passed." when no thresholds are configured.
