---
description: "Type module: Type.JsonSchema for named reusable types with optional inheritance and CEL-based business rules"
---

# Type

Named data types for Telo. A `Type.JsonSchema` resource defines a reusable type — a JSON Schema body, optional inheritance from other named types, and optional CEL-based business rules. Any invocable that accepts `inputType` or `outputType` (`JavaScript.Script`, `Starlark.Script`, `Sql.Select`, HTTP handlers) can reference it by name.

Defining types once and referencing them keeps schemas consistent across producers and consumers and lets the analyzer check CEL expressions against known field shapes.

---

## Type.JsonSchema

```yaml
kind: Type.JsonSchema
metadata:
  name: User
schema:
  type: object
  properties:
    id: { type: string, format: uuid }
    email: { type: string, format: email }
    createdAt: { type: string, format: date-time }
  required: [id, email]
```

The `schema` field is validated with the standard JSON Schema dialect the analyzer ships with (Draft-07 features plus common Draft-2020-12 keywords). Everything you would put in an inline schema works here.

---

## Referencing a type

Any field annotated `x-telo-ref: "telo#Type"` accepts a type name as a string:

```yaml
kind: JavaScript.Script
metadata:
  name: LoadUser
inputType: UserQuery
outputType: User
code: |
  function main({ id }) {
    return { id, email: `user-${id}@example.com`, createdAt: new Date().toISOString() };
  }
```

The analyzer follows the reference, expands the schema, and validates the CEL expressions that feed the script against the declared input shape.

---

## `extends` — type composition

A type can inherit from one or more parents. Parent schemas are merged property-by-property; required fields accumulate.

```yaml
kind: Type.JsonSchema
metadata:
  name: Timestamped
schema:
  type: object
  properties:
    createdAt: { type: string, format: date-time }
    updatedAt: { type: string, format: date-time }
  required: [createdAt, updatedAt]
---
kind: Type.JsonSchema
metadata:
  name: User
extends: Timestamped
schema:
  type: object
  properties:
    id: { type: string }
    email: { type: string }
  required: [id, email]
```

`extends` accepts a single name or a list. Conflicts (two parents defining the same property with incompatible schemas) are flagged by the analyzer.

---

## `rules` — business invariants

Rules augment the JSON Schema with CEL-based predicates. The `condition` must return `true` for valid data; failure surfaces a diagnostic with the declared `code` and optional `message`.

```yaml
kind: Type.JsonSchema
metadata:
  name: DateRange
schema:
  type: object
  properties:
    start: { type: string, format: date }
    end: { type: string, format: date }
  required: [start, end]
rules:
  - code: START_BEFORE_END
    condition: "this.start < this.end"
    message: "start must be before end"
  - code: MAX_SPAN
    condition: "duration(this.end) - duration(this.start) <= duration('365d')"
    message: "range cannot exceed one year"
```

Inside `condition`, `this` is bound to the value being validated. Rules fire after the JSON Schema check passes — so you can assume structural correctness.

Rule codes are invocation error codes (see [Run.Sequence structured errors](../run/docs/structured-errors.md)) — any catch block that matches the code can react to a specific business-rule failure.

---

## Usage patterns

- **Input/output contracts for scripts** — define `inputType` / `outputType` once, reference from `JavaScript.Script` / `Starlark.Script`.
- **HTTP schemas** — refer to a named type from a route's `schema.body` or `schema.query` to keep the OpenAPI output aligned with internal types.
- **Shared vocabularies** — a dedicated type module (`Telo.Library`) lets multiple applications import the same `User`, `Order`, `Invoice` types without duplication.
