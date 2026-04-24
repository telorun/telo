---
description: "Inheritance via extends: abstract interface declaration (Telo.Abstract) and implementation pattern for pluggable subsystems"
---

# Inheritance

`extends` on a `Telo.Definition` declares that the kind **fulfills an abstract interface** declared by another module. This is the extension point for pluggable subsystems: one module defines the contract, other modules provide implementations.

```yaml
# modules/workflow-temporal/telo.yaml
kind: Telo.Import
metadata:
  name: Workflow
source: ../workflow
---
kind: Telo.Definition
metadata:
  name: Backend
capability: Telo.Provider
extends: Workflow.Backend
```

`extends` is distinct from `capability`. `capability` assigns a **lifecycle role** (`Telo.Invocable`, `Telo.Provider`, `Telo.Service`, `Telo.Runnable`, `Telo.Mount`, `Telo.Type`). `extends` declares **which abstract interface** this definition implements. The two are orthogonal and usually combined.

`extends` takes an **alias-form** string `"<Alias>.<AbstractName>"` — the same shape as kind prefixes (`kind: Http.Api`, `kind: Workflow.Graph`). The alias is resolved against the declaring file's own `Telo.Import` declarations, so the target's module version is pinned through the import source. Identity-form strings (`"std/workflow#Backend"`) are intentionally rejected: they don't carry version information and they duplicate resolution paths.

---

## Declaring an Abstract Interface (`Telo.Abstract`)

A module declares an abstract interface with `kind: Telo.Abstract`. This registers a named slot that other modules can target via `extends`.

```yaml
# modules/workflow/telo.yaml
kind: Telo.Abstract
metadata:
  name: Backend
capability: Telo.Provider
```

`Telo.Abstract` accepts `metadata`, `capability`, and `schema` — but never `controllers` (it has no runtime implementation). The `capability` on the abstract propagates to implementations through the kernel's capability chain: an abstract whose `capability: Telo.Invocable` makes every implementation invocable.

---

## Providing an Implementation

A definition extends an abstract interface by (a) importing the abstract's library and (b) setting `extends` to `<Alias>.<AbstractName>`:

```yaml
kind: Telo.Import
metadata:
  name: Workflow
source: ../workflow
---
kind: Telo.Definition
metadata:
  name: Backend
capability: Telo.Provider
extends: Workflow.Backend
schema:
  type: object
  properties:
    address: { type: string }
    namespace: { type: string }
controllers:
  - pkg:npm/@telorun/workflow-temporal@>=0.1.0?local_path=./nodejs#backend
```

**Analyzer behavior:** For every reference typed `x-telo-ref: "std/workflow#Backend"`, the analyzer accepts any resource whose kind's definition has an `extends` edge leading to `workflow.Backend` (the canonical form after alias resolution). `extendedBy` is populated from both `extends` and `capability` so both the canonical and legacy patterns coexist.

---

## Legacy: `capability: <UserAbstract>`

Before `extends` was first-class, implementations declared themselves by overloading `capability` to name the abstract directly: `capability: Workflow.Backend` instead of `capability: Telo.Provider, extends: Workflow.Backend`. The analyzer still honours this form — the `extendedBy` index is populated from both `capability` and `extends`, unioned — so existing third-party modules continue to work.

The analyzer emits a `CAPABILITY_SHADOWS_EXTENDS` warning whenever `capability` names a user-declared abstract (i.e. `metadata.module !== "Telo"`). Builtin lifecycle capabilities never trigger it. Migrate by splitting the axes:

```yaml
# Before (legacy, warned)
capability: Workflow.Backend

# After (canonical)
capability: Telo.Provider
extends: Workflow.Backend
```

---

## Reference from Schema

Abstract kinds are referenced in other definitions' schemas using `x-telo-ref`, identity-form:

```yaml
# In Workflow.Graph's schema
properties:
  backend:
    x-telo-ref: "std/workflow#Backend"
```

The analyzer resolves this to the canonical `workflow.Backend` kind and accepts any resource whose definition has `extends: Workflow.Backend` (or any alias pointing at the same module).

**Why identity form for `x-telo-ref` but alias form for `extends`?** A schema that declares an `x-telo-ref` is a permanent part of its module's API surface — it must resolve the same way regardless of who imports it, so it spells out the full identity. `extends`, by contrast, is evaluated within the declaring file's own import scope, so it piggybacks on whatever alias that file already uses to pull in the abstract's module.

---

## Summary

| Field           | Purpose                                               | Scope                                                 |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `capability`    | Assigns a lifecycle role                              | Any definition                                        |
| `extends`       | Declares which abstract interface the kind implements | Any definition; alias-form via file's `Telo.Import`   |
| `Telo.Abstract` | Declares a pluggable abstract interface               | Any library                                           |
