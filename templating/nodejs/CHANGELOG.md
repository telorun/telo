# @telorun/templating

## 1.0.0

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
  - @telorun/sdk@1.0.0

## 0.2.3

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.2

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.1

### Patch Changes

- 30bcfef: Catch references to nonexistent step results in Run.Sequence-shaped manifests at static-analysis time.

  Two analyzer gaps let a broken CEL chain like `steps.parseManifest.result.docs[?0].?kind` slip past `telo check` and only fail at runtime with `No such key: parseManifest`:

  - `@telorun/analyzer`: `buildStepContextSchema` registered every named step in the steps map, including control-flow wrappers (`try`, `if`, `while`, `switch`, `throw`) that never produce a result. With a permissive `result: { additionalProperties: true }` placeholder under each wrapper, the chain validator treated every typo or stale reference as valid. Now only steps that carry an `invoke` field register a result-producer entry; wrappers are still descended into via `x-telo-topology-role: branch`, so their inner invokes are unaffected.
  - `@telorun/templating`: `extractAccessChains` only descended into `node.args` when it was an array. cel-js represents unary operators (`!_`, `-_`) with a single `ASTNode` directly in `args`, so any chain inside `!(...)` or `-(...)` was dropped from validation. The walker now also descends when `args` is a single `ASTNode`.

  Both fixes are needed for the typical "negated optional-access chain in a try-wrapped step" pattern (e.g. an `if: "${{ !(steps.<wrapper>.result.docs[?0].?kind ...) }}"` predicate).

## 0.2.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.
