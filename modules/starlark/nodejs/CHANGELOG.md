# @telorun/starlark

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

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

## 0.2.5

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.4

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.3

### Patch Changes

- d3ed5a5: Annotate multi-line authoring fields with `x-telo-widget: code` so the telo editor renders a Monaco editor instead of a single-line text input. `Ai.Text.system` and `Ai.TextStream.system` get `text/markdown`; `Sql.Query.inputs.sql`, `Sql.Exec.inputs.sql`, and `Sql.Migration.sql` get `application/sql`; `Starlark.Script.code` gets the widget without a `contentMediaType` (Monaco has no Starlark language, so it falls back to plaintext rather than mis-highlighting as Python).

## 0.2.2

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.2.0

### Minor Changes

- fc4a562: Add a native Rust controller for `std/starlark`, opt-in via `runtime: rust` on a `Telo.Import`. Implementation lives at `modules/starlark/rust/` and is loaded by the kernel's `NapiControllerLoader` (delivered in the prior PR). The existing `nodejs` controller stays the kernel-native default — no change for manifests that don't set `runtime:`.

  The Rust controller is currently a PoC scaffold using the new `telorun-sdk` Rust crate (in-tree, not yet published to crates.io): `#[controller]` is the only macro the author touches, and the controller crate is a textbook Rust project with no `use napi` or `#[napi]` in its source. Replacing the scaffold's invoke body with a real `starlark-rust` evaluation is the natural next step — the SDK and macro shape are final.

  Schema and orchestration layers are untouched; this is purely a new implementation behind an existing definition.

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.11

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.10

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
