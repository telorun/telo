# @telorun/benchmark

## 0.1.8

### Patch Changes

- e255b6f: Fix `Benchmark.Suite` quick-wins:

  - Pass per-scenario `invoke.inputs` through to `ctx.invoke()` instead of an empty object — the documented README pattern was previously silently dropped for scenarios that referenced an existing invocable by name.
  - Declare `exports.kinds: [Suite]` in `telo.yaml` so the analyzer can validate importer references.
  - Add `bun` / `import` conditions to the `./suite` export and a `main` field so the package resolves to `dist/suite.js` for Node.js consumers (was source-`.ts`-only, unpublishable).
  - Stop printing "All thresholds passed." when no thresholds are configured.

## 0.1.7

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.1.6

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.6
