# Plan — Typed `Telo.Abstract` (I/O contracts on capabilities)

Scope: let `Telo.Abstract` declarations carry `inputType` / `outputType` schemas, and have the analyzer + kernel enforce them so open-extension abstracts (like `Ai.Model`) can promise a contract that third-party implementations must honor.

Out of scope: replacing the existing `Telo.Invocable` / `Telo.Service` / etc. builtins with typed versions (they stay untyped; new abstracts opt in).

## 1. Why

Telo already supports third-party modules extending any abstract via `capability: X.Abstract`. But today there is no enforced contract between the abstract and its implementations — a deviating implementation only breaks at runtime, deep inside a caller's invoke. This matters most for open-extension points: `Ai.Model`, future `Queue.Backend`-style kinds, any plugin surface.

The pieces exist but aren't composed:

- `Type.JsonSchema` kind ([modules/type/](../../../modules/type/)) declares named schemas.
- `inputType` / `outputType` field pattern already works on concrete kinds ([javascript/tests/inline-type.yaml](../../../modules/javascript/tests/inline-type.yaml)).
- `createTypeValidator()` in [resource-context.ts](../src/resource-context.ts) resolves types and produces runtime validators — but callers must invoke it manually.
- Analyzer validates `x-telo-schema-from` cross-refs at load time ([validate-references.ts](../../../analyzer/nodejs/src/validate-references.ts)) — but does not check abstract conformance.

This plan wires those pieces into an end-to-end contract enforcement loop.

## 2. Shape of a typed abstract

Extend the `Telo.Abstract` schema to accept optional `inputType` and `outputType`, reusing the existing `Type.JsonSchema` inline/named pattern.

```yaml
kind: Telo.Abstract
metadata:
  name: Model
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      messages:
        type: array
        items:
          type: object
          properties:
            role: { type: string, enum: [system, user, assistant] }
            content: { type: string }
          required: [role, content]
      options: { type: object }
    required: [messages]
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      text: { type: string }
      usage:
        type: object
        properties:
          promptTokens: { type: integer }
          completionTokens: { type: integer }
          totalTokens: { type: integer }
        required: [promptTokens, completionTokens, totalTokens]
    required: [text, usage]
```

Both inline (shown above) and named (`inputType: SomeSchemaName` referring to a `Type.JsonSchema` resource) are supported, matching existing `inputType` use on `JavaScript.Script`.

Abstracts without `inputType` / `outputType` are untyped and the feature is fully opt-in.

## 3. Conformance check (analyzer, load time)

New analyzer phase — likely slots in after Phase 3 reference resolution, before Phase 4 CEL validation. For every `Telo.Definition` whose `capability` points at a typed abstract:

1. Look up the abstract's `inputType` / `outputType`.
2. Resolve the definition's own `inputs` field schema (top-level property in its `schema`) and its declared `outputType` — if either is absent, treat as `true` (accepts anything / promises nothing).
3. Run subtype checks:
   - **Input:** `definition.inputs ⊇ abstract.inputType` — the definition must accept *at least* what the abstract promises callers will pass. Concretely: every required field on the abstract input must also exist in the definition input, with a compatible type; the definition may have extra optional fields.
   - **Output:** `definition.outputType ⊆ abstract.outputType` — the definition must return *at least* what the abstract promises. Every required field on the abstract output must be present on the definition output; the definition may return extras.
4. Emit structured diagnostics on mismatch: abstract name, definition kind, offending JSON Pointer, expected vs. actual schema fragment.

Subtype algorithm scope for v1 (keep narrow):

- `type`: must match exactly, or definition's is in `[abstractType]` anyOf.
- `properties`: recurse per-property.
- `required`: input — definition.required must be ⊆ abstract.required (can demand less, not more). Output — definition.required must be ⊇ abstract.required (can promise more).
- `items`: recurse.
- `enum`: input — definition.enum must be ⊇ abstract.enum; output — ⊆.
- `additionalProperties: false`: forbidden on the definition side for input if the abstract is open; tolerated otherwise.
- Defer: `$ref`, `oneOf`/`anyOf` on the definition side, `format`, `pattern`, numeric ranges. Warn "cannot verify" rather than false-positive fail.

A hand-rolled subtype walker is simpler and more informative than bending an off-the-shelf validator. AJV validates instance-vs-schema, not schema-vs-schema.

## 4. Runtime validation (kernel)

Wire `ctx.invoke()` / `invokeResolved()` in [resource-context.ts](../src/resource-context.ts) to:

1. Resolve the target resource's effective `inputType`: its own if declared, else its capability abstract's, else none.
2. If an `inputType` exists, lazily compile a validator (cache per kind — abstracts and definitions are immutable post-load) and run it against the passed inputs.
3. On failure, throw a structured error (`TypeValidationError`) with the target kind/name, offending JSON Pointer, and the violation message. No fallback, no coercion.

Output validation is off by default — compile-and-validate every invoke output is expensive and provides marginal value in production. Gated behind a kernel flag (`validateOutputs: boolean`) that tests and dev-time tooling flip on.

## 5. Strictness levels

Two dials, both on the kernel root (not per-resource):

| Flag                | Default | Behavior                                                  |
| ------------------- | ------- | --------------------------------------------------------- |
| `validateInputs`    | `true`  | Enforce input contract on every `ctx.invoke`.             |
| `validateOutputs`   | `false` | When on, enforce output contract on every `ctx.invoke`.   |

Surfaced as `Kernel.loadFromConfig({ validation: { inputs, outputs } })`. Test suite enables both; CLI leaves both at defaults.

No per-invoke override — too much surface for too little value. If a hot path genuinely can't afford validation, that's a future optimization (validator compilation already caches; the cost is per-call `ajv.validate`).

## 6. Migration & backwards compatibility

- Existing builtins (`Telo.Invocable`, `Telo.Service`, etc.) stay untyped.
- Existing concrete kinds are unaffected until they implement a newly-typed abstract.
- Adding typing to an existing abstract is a breaking change for its implementors; it will be announced as such. Kernel builtins are frozen at untyped; library abstracts can evolve.

## 7. Tooling impact

- Analyzer diagnostics already flow through [packages/ide-support/](../../../packages/ide-support/) into VS Code. Conformance errors piggyback on the existing diagnostic channel — surface kind (`TypeMismatch`), severity (`error`), message, location (file + JSON Pointer).
- Telo editor gets the same diagnostics via the analyzer surface — no editor-specific changes needed.
- CLI `telo ./manifest.yaml` should print conformance errors in the same format as existing reference/CEL errors.

## 8. Testing strategy

- **Analyzer unit tests** ([analyzer/nodejs/tests/](../../../analyzer/nodejs/)) — typed abstract + conformant impl (pass), typed abstract + deviating impl (specific structural diagnostics), untyped abstract + any impl (no-op).
- **Kernel integration tests** ([tests/](../../../tests/)) — typed abstract + conformant impl + valid invoke (pass), invalid invoke (TypeValidationError), disabled validation (no-op).
- **Subtype algorithm tests** — property-based if practical, otherwise a matrix covering each supported keyword.
- **Cross-package test** — abstract in library A, implementation in library B, caller in a third module. Verifies cross-module resolution.

## 9. Open questions

1. **Subtype algorithm depth.** The v1 subset (§3) is deliberately limited. Where do we draw the line in v1 vs v2? I lean: ship §3 as-is, add `oneOf`/`anyOf` in v2. Refs (`$ref`) across modules get tricky — defer.

2. **Error message UX.** Structural diagnostics on deeply-nested schemas can be hard to read. Before shipping, sanity-check diagnostic output against a realistic case (Ai.Model with a deviating provider) to see whether pointer-based messages are enough or we need schema-diff rendering.

3. **Should the abstract schema be a `Type.JsonSchema` resource by reference from day 1, or inline-only in v1?** Both work; inline-only is smaller to ship. Named refs let multiple abstracts share a schema (e.g. `HttpLikeRequest`). I lean inline-only v1, add named refs if a use case appears.

4. **Runtime validation ordering vs. CEL expansion.** `ctx.invoke(kind, name, inputs)` — `inputs` may still contain CEL expressions at the call site. Are they expanded before we validate, or after? Must be after — validation is against resolved values. Need to confirm this is how `invoke` already sequences things; if CEL expansion happens inside the target controller rather than before the call, we need to push it out or accept that validation happens inside the target. Investigate before coding.

5. **Does validation run on Provider `init()` fields too?** Providers are init-time, not invoke-time. If a typed abstract ever has `capability: Telo.Provider`, the "input" shape is the resource manifest itself, validated at load time by the existing JSON Schema validation. Conformance check still applies. No new runtime validation needed — load-time catches it. Confirm this edge case is coherent.

## 10. Execution order

1. **Open-question resolution.** Dig into Q4 (CEL expansion vs. validation) — this is the one that could invalidate the design. If expansion happens inside the target controller, redesign.
2. Extend `Telo.Abstract` schema in [builtins.ts](../../../analyzer/nodejs/src/builtins.ts) to accept `inputType` / `outputType`.
3. Implement the subtype walker as a standalone module in the analyzer (`analyzer/nodejs/src/json-schema-subtype.ts`). Unit-test heavily before wiring into the analyzer pipeline.
4. Wire conformance check into the analyzer's validate phase.
5. Wire input validation into `ctx.invoke` in the kernel. Thread `validation` option through `Kernel.loadFromConfig`.
6. Add output validation behind the flag.
7. Write cross-package integration test fixture.
8. Land `Ai.Model` as the first real consumer (coordinate with [modules/ai/plans/model-and-completion.md](../../../modules/ai/plans/model-and-completion.md)).
9. Docs — add to [kernel/docs/](../../docs/) describing typed abstracts, with the Ai.Model contract as the worked example.
10. Changeset covering `@telorun/analyzer`, `@telorun/kernel`, and the new tests.
