# @telorun/benchmark

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.3.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.2.0

### Minor Changes

- 0f80fc5: `Bench.Suite.scenarios[*]` and `Http.Server.notFoundHandler` follow the canonical sibling shape: `invoke:` describes the dispatch target only; `inputs:` carries the call-time arguments as a sibling. The previously-accepted nested `invoke.inputs` form is gone — the benchmark runtime now reads `scenario.inputs` and the http-server runtime now reads `notFoundHandler.inputs`. Five benchmark manifests, one example, and `apps/registry/telo.yaml` migrated to the sibling form.

  Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` / top-level `inputs:` / top-level `result:` fields, catching typos at load time instead of first invocation.

  Aligns Telo.Definition's template-body shape with how Run.Sequence steps factor dispatch from data: `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (provide-only post-call mapping) live as top-level siblings on the definition. The previous nested `invoke.inputs` shape is gone — the kernel template controller now reads `definition.inputs`, and `modules/sql-repository/Read` migrates to the sibling form.

  Inside top-level `result:`, the `result` CEL variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is also AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared. Mismatches surface as a new `TEMPLATE_TARGET_MISMATCH` diagnostic.

  Adds two reusable context-annotation forms used by the `Telo.Definition` builtin schema and available to any module that needs the same capabilities:

  - `x-telo-context-from-root: "<path>"` — root-anchored navigation (replace semantics), used to type variables sourced from a top-level field regardless of where the CEL appears.
  - `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema.

  Schema-extracted contexts are now sorted by scope specificity (longest first) so the first-match-wins resolver picks the most-specific context. No existing module relied on the previous ordering (no overlapping scopes), so this change is observably backward-compatible.

## 0.1.11

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.1.10

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.1.9

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

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
