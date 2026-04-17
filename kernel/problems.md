# Telo Core Concepts — Architectural Problems

## 1. `Telo.Definition` Is a God Object

A single definition carries:

- `capability` — lifecycle role
- `schema` — instance shape
- `controllers` — implementation binding
- `x-telo-*` extensions scattered in schema

**Current state:** The god-object structure is intact. Four `x-telo-*` variants exist
(`x-telo-ref`, `x-telo-context`, `x-telo-scope`, `x-telo-schema-from`), all embedded
inside `schema` property definitions. Capabilities are not structurally uniform:

- `x-telo-context` appears only in `Telo.Mount` definitions (`http-server` — injects
  request context into handler invocations)
- `x-telo-scope` appears only in `Telo.Runnable` definitions (`run` — restricts CEL
  scope to a sub-path)

Each capability that needs framework-level semantics adds its own bespoke schema
extension. The flat `Telo.Definition` provides no structural slot for these — they
accumulate as informal conventions inside `schema`. A split along capability lines (or a
dedicated `hooks`/`extensions` field) would make these explicit.

## 2. `capability` Values Have a Naming Inconsistency

Inside a `Telo.Definition`, `capability` values use the `Telo.` prefix:

```yaml
kind: Telo.Definition
capability: Telo.Service
```

The `Telo.` prefix appears redundantly — you're already inside a `Telo.Definition`, so `Telo.Service` ≡ `Service`. But current module definitions use `capability: Telo.Service` (with prefix) vs some docs using `capability: Mount` (no prefix). This inconsistency bleeds into the analyzer and generates confusing error messages.

## 3. No Type Inheritance or Interface Composition

If you want an `AuthenticatedApi` that extends `Http.Api` with auth middleware injected, there's no mechanism. Options are:

- Duplicate the schema entirely
- Use parametric templates (parametric typing, not inheritance)
- Wrap with an adapter (composition, but awkward in this model)

The `x-telo-ref: Telo.Invocable` mechanism hints at interface-like contracts but it's read-only — you can say "this field must be Invocable" but you can't say "this type extends X and adds Y".

## 4. ~~Kernel Globals Not Available in `x-telo-context` Scopes~~ (resolved)

**Fix:** `buildKernelGlobalsSchema` in `analyzer/nodejs/src/kernel-globals.ts` builds typed schemas from the manifest (variable/secret declarations, resource names, import aliases) and `mergeKernelGlobalsIntoContext` merges them into every `x-telo-context` before chain validation. Module schemas only declare context-specific variables; redundant `variables`/`secrets`/`resources` entries removed from http-server.

## Summary

| Concept             | Core Problem                                                                                                                            | Direction                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `Telo.Definition`   | Capability-specific semantics (`x-telo-context`, `x-telo-scope`) accumulate as informal schema conventions; no structural slot for them | Split by capability or add a dedicated `hooks`/`extensions` field |
| `capability` values | Inconsistent prefix usage                                                                                                               | Drop `Telo.` prefix inside Definition; use enum                   |
| Type inheritance    | Missing entirely                                                                                                                        | At minimum: `extends:` for schema composition                     |
| Kernel globals      | `x-telo-context` doesn't include kernel globals; validator rejects valid CEL like `resources.X`                                         | Auto-merge kernel globals into every context before validation    |
