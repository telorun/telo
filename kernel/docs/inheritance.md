---
description: "Inheritance via extends: abstract interface declaration (Telo.Abstract) and implementation pattern for pluggable subsystems"
---

# Inheritance

`extends` on a `Telo.Definition` declares that the kind **fulfills an abstract interface** declared by another module. This is the extension point for pluggable subsystems: one module defines the contract, other modules provide implementations.

```yaml
# modules/workflow-temporal/telo.yaml
kind: Telo.Definition
metadata: { name: Backend, module: WorkflowTemporal }
capability: Provider
extends: Workflow.Backend
```

`extends` is distinct from `capability`. `capability` assigns a lifecycle role. `extends` declares which abstract interface this definition implements. The two are orthogonal and may be combined.

---

## Declaring an Abstract Interface (`Telo.Abstract`)

A module declares an abstract interface with `kind: Telo.Abstract`. This registers a named slot that other modules can target via `extends`.

```yaml
# modules/workflow/telo.yaml
kind: Telo.Abstract
metadata: { name: Backend, module: Workflow }
capability: Provider
```

`Telo.Abstract` accepts the same fields as `Telo.Definition` except `controllers` — it has no implementation. It defines the contract (capability, schema, inputs/outputs) that all implementations must satisfy.

The fully-qualified name of the abstract kind (`Workflow.Backend`) becomes the value used in `extends` by implementors.

---

## Providing an Implementation

A definition extends an abstract interface by setting `extends` to the abstract kind's qualified name:

```yaml
kind: Telo.Definition
metadata: { name: Backend, module: WorkflowTemporal }
capability: Provider
extends: Workflow.Backend
schema:
  type: object
  properties:
    address: { type: string }
    namespace: { type: string }
controllers:
  - pkg:npm/@telorun/workflow-temporal@>=0.1.0?local_path=./nodejs#backend
```

**Kernel behavior:** The kernel verifies that the implementing definition's `capability` is compatible with the abstract's declared `capability`. The abstract's `schema` is merged as a base — the implementation may extend it with additional properties.

**Analyzer behavior:** Any resource whose schema references the abstract kind via `x-telo-ref` will accept instances of any definition that `extends` it. This is how `Workflow.Graph` accepts any `Workflow.Backend` implementation without knowing about specific implementors.

---

## Reference from Schema

Abstract kinds are referenced in schemas using `x-telo-ref`:

```yaml
# In Workflow.Graph's schema
properties:
  backend:
    x-telo-ref: "std/workflow#Backend"
```

The analyzer resolves this to `Workflow.Backend` and accepts any resource instance whose `kind` definition has `extends: Workflow.Backend`.

---

## Summary

| Field             | Purpose                                               | Scope                    |
| ----------------- | ----------------------------------------------------- | ------------------------ |
| `capability`      | Assigns a lifecycle role                              | Kernel built-ins only    |
| `extends`         | Declares which abstract interface the kind implements | Cross-module, non-kernel |
| `Telo.Abstract` | Declares a pluggable abstract interface               | Within a module          |
