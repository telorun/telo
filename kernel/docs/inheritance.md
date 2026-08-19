---
description: "Inheritance via extends: abstract interface declaration (Telo.Abstract) and implementation pattern for pluggable subsystems"
---

# Inheritance

`extends` on a `Telo.Definition` declares that the kind **fulfills an abstract interface** declared by another module. This is the extension point for pluggable subsystems: one module defines the contract, other modules provide implementations.

```yaml
# modules/sql-postgres/telo.yaml
kind: Telo.Library
metadata:
  name: SQLPostgres
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

`extends` is distinct from `capability`. `capability` assigns a **lifecycle role** (`Telo.Invocable`, `Telo.Provider`, `Telo.Service`, `Telo.Runnable`, `Telo.Mount`, `Telo.Type`). `extends` declares **which abstract interface** this definition implements. The two are orthogonal and usually combined.

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
  name: SQLPostgres
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
  - pkg:telo/local/js?path=./nodejs/sql-postgres.mjs&local_path=./nodejs/src/index.ts#connection
```

**Analyzer behavior:** For every reference typed `x-telo-ref: Sql.Connection`, the analyzer accepts any resource whose kind's definition has an `extends` edge leading to `SQL.Connection` (the canonical form after alias resolution). Acceptance is transitive, so a kind extending a kind that extends the abstract is accepted too. `extendedBy` is populated from both `extends` and `capability` so both the canonical and legacy patterns coexist.

---

## Legacy: `capability: <UserAbstract>`

Before `extends` was first-class, implementations declared themselves by overloading `capability` to name the abstract directly: `capability: Sql.Connection` instead of `capability: Telo.Provider, extends: Sql.Connection`. The analyzer still honours this form — the `extendedBy` index is populated from both `capability` and `extends`, unioned — so existing third-party modules continue to work.

The analyzer emits a `CAPABILITY_SHADOWS_EXTENDS` warning whenever `capability` names a user-declared abstract (i.e. `metadata.module !== "Telo"`). Builtin lifecycle capabilities never trigger it. Migrate by splitting the axes:

```yaml
# Before (legacy, warned)
capability: Sql.Connection

# After (canonical)
capability: Telo.Provider
extends: Sql.Connection
```

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
