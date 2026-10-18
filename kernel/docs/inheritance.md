---
description: "Inheritance via extends: abstract interface declaration (Telo.Abstract) and implementation pattern for pluggable subsystems"
---

# Inheritance

`extends` on a `Telo.Definition` declares that the kind **fulfills an abstract interface** declared by another module. This is the extension point for pluggable subsystems: one module defines the contract, other modules provide implementations.

```yaml
# modules/postgres/telo.yaml
kind: Telo.Library
metadata:
  name: Postgres
  version: 1.0.0
imports:
  Sql: ../sql
---
kind: Telo.Definition
metadata:
  name: Connection
capability: Telo.Provider
extends: Sql.Connection
```

`extends` is distinct from `capability`. `capability` assigns a **lifecycle role** from a closed roster (`Telo.Callable`, `Telo.Invocable`, `Telo.Mount`, `Telo.Provider`, `Telo.Runnable`, `Telo.Service`, `Telo.Sink`, `Telo.Type`). `extends` declares **which abstract interface** this definition implements. The two are orthogonal and usually combined.

`extends` takes an **alias-form** string `"<Alias>.<AbstractName>"` — the same shape as kind prefixes (`kind: Http.Api`, `kind: Sql.Query`). The alias is resolved against the declaring file's own `imports:` map, so the target's module version is pinned through the import source. Identity-form strings (`"std/sql#Connection"`) are intentionally rejected: they don't carry version information and they duplicate resolution paths. `x-telo-ref` takes the same alias form, for the same reasons.

---

## Declaring an Abstract Interface (`Telo.Abstract`)

A module declares an abstract interface with `kind: Telo.Abstract`. This registers a named slot that other modules can target via `extends`.

```yaml
# modules/sql/telo.yaml
kind: Telo.Abstract
metadata:
  name: Connection
capability: Telo.Provider
```

`Telo.Abstract` accepts `metadata`, `capability`, and `schema` — but never `controllers` (it has no runtime implementation). The `capability` on the abstract propagates to implementations through the kernel's capability chain: an abstract whose `capability: Telo.Invocable` makes every implementation invocable.

---

## Providing an Implementation

A definition extends an abstract interface by (a) importing the abstract's library via the module doc's `imports:` map and (b) setting `extends` to `<Alias>.<AbstractName>`:

```yaml
kind: Telo.Library
metadata:
  name: Postgres
  version: 1.0.0
imports:
  Sql: ../sql
---
kind: Telo.Definition
metadata:
  name: Connection
capability: Telo.Provider
extends: Sql.Connection
schema:
  type: object
  properties:
    url: { type: string }
    poolSize: { type: integer }
controllers:
  - pkg:telo/local/js?path=./nodejs/postgres.mjs&local_path=./nodejs/src/index.ts#ConnectionController
```

**Analyzer behavior:** For every reference typed `x-telo-ref: Sql.Connection`, the analyzer accepts any resource whose kind's definition has an `extends` edge leading to `SQL.Connection` (the canonical form after alias resolution). Acceptance is transitive, so a kind extending a kind that extends the abstract is accepted too. A `capability:` adds one more edge, to the role it names: a kind declaring `capability: Telo.Invocable` is accepted where `Telo.Invocable` (and its parent `Telo.Executable`) is — role membership, never inheritance of a schema or contract.

---

## Legacy: `capability: <UserAbstract>`

Before `extends` was first-class, implementations declared themselves by overloading `capability` to name the abstract directly: `capability: Sql.Connection` instead of `capability: Telo.Provider, extends: Sql.Connection`. `capability:` now has one meaning — a lifecycle role from the closed roster — and the legacy spelling is carried by a migration rather than by a second meaning in code.

The `capability-as-extends` migration rewrites `capability: <Alias>.<Kind>` (any alias but `Telo`) to `extends: <Alias>.<Kind>` at load and reports `CAPABILITY_SHADOWS_EXTENDS`, a deprecation warning, for the entry module's own files; `telo migrate` writes the rewrite to the file. A migrated kind is checked as the child it always claimed to be: the abstract's schema merges into its author surface, and the abstract's invocation contract, `throws` ceiling and capability apply — so a published dependency that violated its abstract's contract now fails, where it was skipped before.

```yaml
# Before (legacy, migrated and warned)
capability: Sql.Connection

# After (canonical)
extends: Sql.Connection
```

The capability is inherited from the abstract when it declares one; restate it identically only if you want it written down. Where `extends:` is already declared the rename has nowhere to go — a definition has one parent — and the value is refused as `CAPABILITY_UNKNOWN`. The Rust kernel applies no migration and refuses the legacy spelling as `ERR_CAPABILITY_UNKNOWN`; it supports no `extends:` either, so such a kind never ran there.

---

## Reference from Schema

Abstract kinds are referenced in other definitions' schemas using `x-telo-ref`, in the **same alias-qualified form** `extends` takes:

```yaml
# In Sql.Query's schema
properties:
  connection:
    x-telo-ref:
      kind: Self.Connection
      use: dependency
```

`Self.<Kind>` names a kind the declaring library owns; `<Alias>.<Kind>` names one it imports; `Telo.<Kind>` names a built-in. The constraint is resolved in the **declaring** module's scope and rewritten to the canonical `<module>.<Kind>` before registration, so the registry answers reference queries with no module context — which is what lets one grammar serve both fields.

The legacy identity form (`"std/sql#Connection"`) still resolves, for module versions published before the unification, and warns as `X_TELO_REF_LEGACY_IDENTITY`.

---

## Summary

| Field           | Purpose                                               | Scope                                                 |
| --------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `capability`    | Assigns a lifecycle role                              | Any definition                                        |
| `extends`       | Declares which abstract interface the kind implements | Any definition; alias-form via file's `imports:` map  |
| `Telo.Abstract` | Declares a pluggable abstract interface               | Any library                                           |
