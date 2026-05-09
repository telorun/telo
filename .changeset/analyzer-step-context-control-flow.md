---
"@telorun/analyzer": patch
"@telorun/templating": patch
---

Catch references to nonexistent step results in Run.Sequence-shaped manifests at static-analysis time.

Two analyzer gaps let a broken CEL chain like `steps.parseManifest.result.docs[?0].?kind` slip past `telo check` and only fail at runtime with `No such key: parseManifest`:

- `@telorun/analyzer`: `buildStepContextSchema` registered every named step in the steps map, including control-flow wrappers (`try`, `if`, `while`, `switch`, `throw`) that never produce a result. With a permissive `result: { additionalProperties: true }` placeholder under each wrapper, the chain validator treated every typo or stale reference as valid. Now only steps that carry an `invoke` field register a result-producer entry; wrappers are still descended into via `x-telo-topology-role: branch`, so their inner invokes are unaffected.
- `@telorun/templating`: `extractAccessChains` only descended into `node.args` when it was an array. cel-js represents unary operators (`!_`, `-_`) with a single `ASTNode` directly in `args`, so any chain inside `!(...)` or `-(...)` was dropped from validation. The walker now also descends when `args` is a single `ASTNode`.

Both fixes are needed for the typical "negated optional-access chain in a try-wrapped step" pattern (e.g. an `if: "${{ !(steps.<wrapper>.result.docs[?0].?kind ...) }}"` predicate).
