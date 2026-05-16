# @telorun/templating

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
