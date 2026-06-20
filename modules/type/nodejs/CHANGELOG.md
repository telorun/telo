# @telorun/type

## 0.4.0

### Minor Changes

- d7fda97: Add module-scoped JSON Schema `$ref`s for named `Telo.Type` resources. A `Type.JsonSchema` now registers its schema under a canonical URI `$id` of `telo://<module>/<name>`, so any `inputType` / `outputType` / config `schema` can reference it with a standard JSON Schema `$ref`. Authors write the reference through an import — `telo://Self/<name>` for the declaring module's own type, `telo://<Alias>/<name>` for an imported module's — and the loader resolves the authority to the module name (the version is carried by the `imports:` entry, never the URI).

  - `@telorun/sdk` exports `canonicalTypeSchemaId`, `parseTeloTypeRef`, and `TELO_TYPE_SCHEME`.
  - `@telorun/analyzer` rewrites `telo://Self|Alias/Type` schema refs to their canonical id in both `analyze` and `normalize` (so the kernel runtime, import loads, and static analysis agree), registers named-type schemas in its AJV, and emits `SCHEMA_TYPE_REF_UNRESOLVED` / `SCHEMA_TYPE_REF_UNKNOWN_ALIAS` diagnostics for refs that resolve to nothing.
  - `@telorun/type` registers each `Type.JsonSchema` under its canonical `telo://` id in the runtime schema registry.

  This lets a module declare a shared schema fragment once (e.g. a filter grammar) and reference it from several definitions without duplicating it, while keeping references statically analyzable and version-pinned through the import.

## 0.3.0

### Minor Changes

- 2292a84: Upgraded cel-js package to 7.6.1

## 0.2.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.2.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.1.0

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

## 0.0.10

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.0.9

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.0.8

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.0.7

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.0.6

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.0.5

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.0.4

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.0.3

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.0.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.0.7

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.0.6

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.0.5

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.0.4

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.0.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
