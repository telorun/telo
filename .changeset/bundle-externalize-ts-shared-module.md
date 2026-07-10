---
"@telorun/kernel": patch
---

Fix controller bundling still splitting a package's shared module when the
package is loaded from its TypeScript source (`src/*.ts`). The shared-module
externalization only kept `.js`/`.mjs`/`.cjs` siblings loose and inlined `.ts`
ones — but published modules are loaded from `src/*.ts` under Bun, so a shared
`.ts` module (e.g. record-stream's `journal-store`) was inlined per controller,
giving each its own class copy. `instanceof` across the package's controllers
then failed, surfacing at runtime as `RecordStream: invalid journal reference`.
TypeScript extensions are now externalized like JS: the loose file is loaded by
the same (TS-aware) runtime as the bundle, so a `.ts` sibling resolves and keeps
one identity across the package's controllers.
