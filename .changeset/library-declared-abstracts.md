---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/assert": minor
---

kernel/analyzer: library-declared Telo.Abstract + first-class `extends` + prototype-preserving instance wrap.

- Kernel: new runtime meta-controller for `kind: Telo.Abstract` so libraries can declare abstract contracts that importers resolve at runtime (not just in static analysis). Fixes the latent "No controller registered for kind 'Telo.Abstract'" failure when importing modules like `std/workflow` that declare an abstract.
- Kernel: `_createInstance` now preserves the prototype chain when wrapping an instance with the CEL-expanding `invoke`. Previously `{ ...instance, invoke }` stripped any methods declared on a controller's prototype (including `init`/`teardown`/`snapshot`), silently breaking class-based controllers whose definitions had runtime-eval paths.
- Analyzer: `Telo.Definition` gains an `extends: "<Alias>.<Abstract>"` field (alias-form, resolved against the declaring file's `Telo.Import` declarations — same pattern as kind prefixes). This pins the target's module version through the import source. `DefinitionRegistry.extendedBy` is populated from both `extends` and `capability` (union-merged), so third-party modules using the legacy `capability: <UserAbstract>` overload keep working. A `CAPABILITY_SHADOWS_EXTENDS` warning prompts migration.
- Analyzer: new `validateExtends` pass emits `EXTENDS_MALFORMED` / `EXTENDS_UNKNOWN_TARGET` / `EXTENDS_NON_ABSTRACT` / `CAPABILITY_SHADOWS_EXTENDS` diagnostics.
- Analyzer: Phase 1 registration loop now also registers `kind: Telo.Abstract` docs (previously only `Telo.Definition`), so cross-package `x-telo-ref` references to library-declared abstracts actually resolve.
- SDK: `ResourceDefinition` type gains `extends?: string`.
- Assert: `Assert.Manifest` supports `expect.warnings` alongside `expect.errors`.
- Migration: `modules/workflow-temporal/telo.yaml` moves from `capability: Workflow.Backend` to canonical `capability: Telo.Provider, extends: "std/workflow#Backend"`. No behavioural change.
