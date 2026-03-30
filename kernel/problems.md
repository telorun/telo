# Telo Core Concepts — Architectural Problems

## 3. `Kernel.Definition` Is a God Object

A single definition carries:

- `capability` — lifecycle role
- `schema` — instance shape
- `controllers` — implementation binding
- `expand` — compile/runtime hooks
- `x-telo-*` extensions scattered in schema

The structural concern that remains: does `Kernel.Mount`'s position as the only capability with extra framework-level semantics point toward a deeper split — or are all capabilities now structurally uniform since `x-telo-context` moved scope injection into the schema?

## 4. `capability` Values Have a Naming Inconsistency

Inside a `Kernel.Definition`, `capability` values use the `Kernel.` prefix:

```yaml
kind: Kernel.Definition
capability: Kernel.Service
```

The `Kernel.` prefix appears redundantly — you're already inside a `Kernel.Definition`, so `Kernel.Service` ≡ `Service`. But current module definitions use `capability: Kernel.Service` (with prefix) vs some docs using `capability: Mount` (no prefix). This inconsistency bleeds into the analyzer and generates confusing error messages.

## 5. No Type Inheritance or Interface Composition

If you want an `AuthenticatedApi` that extends `Http.Api` with auth middleware injected, there's no mechanism. Options are:

- Duplicate the schema entirely
- Use parametric templates (parametric typing, not inheritance)
- Wrap with an adapter (composition, but awkward in this model)

The `x-telo-ref: Kernel.Invocable` mechanism hints at interface-like contracts but it's read-only — you can say "this field must be Invocable" but you can't say "this type extends X and adds Y".

## 6. `sdk` Package Contains the Core Runtime

`@telorun/sdk` is named as a public authoring API — the surface module authors use to write controllers. But it actually contains the core runtime engine:

- `EvaluationContext` — the full multi-pass init loop, teardown tree, scope handles
- `ModuleContext` — variables/secrets/resources namespaces, kind alias resolution
- `ExecutionContext` — per-trigger execution overlay
- `ResourceContext` interface — the full kernel service contract

This is the opposite of what an SDK should be. An SDK should expose stable, minimal, outward-facing types that module authors depend on (`ResourceInstance`, `ResourceContext`, capability interfaces). The runtime engine — `EvaluationContext`, `ModuleContext`, the init loop — is an internal implementation detail that module authors should never need to import directly.

The current arrangement has two concrete consequences:

- **Compilation is blocked.** Extracting a kernel-free compiled runtime requires `EvaluationContext` and the init loop to be importable without pulling in the full kernel. Since they live in `sdk`, they appear to be a public contract, creating confusion about what is stable surface vs internal machinery.
- **SDK stability is undermined.** Every internal refactor of `EvaluationContext` (init loop changes, scope handle semantics, context tree changes) is technically a breaking change to a public package. The boundary between "stable API" and "internal engine" is invisible.

### Solution

Move `EvaluationContext`, `ModuleContext`, `ExecutionContext`, the init loop, scope handles, and `CompiledValue` back into `@telorun/kernel` where they belong. The SDK (`@telorun/sdk`) is then reduced to what a public authoring API should be: `ResourceContext` interface, `ResourceInstance`, capability interfaces (`Invocable`, `Runnable`, `Provider`), `ScopeHandle`, `KindRef`.

Controllers import only `@telorun/sdk`. The kernel imports its own internal engine directly — no circular dependency, no leaking of init loop internals into a public package.

## Summary

| Concept             | Core Problem                                                                              | Direction                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `Kernel.Definition` | Capability mixes schema and controllers; `Kernel.Mount` is the odd one out                | Clarify whether `Kernel.Mount` warrants a distinct top-level kind         |
| `capability` values | Inconsistent prefix usage                                                                 | Drop `Kernel.` prefix inside Definition; use enum                         |
| Type inheritance    | Missing entirely                                                                          | At minimum: `extends:` for schema composition                             |
| `sdk` package       | Contains core runtime, not a public authoring API                                         | Move runtime internals back to kernel; SDK exposes only authoring surface |
