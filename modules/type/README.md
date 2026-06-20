# Type

Named, reusable data types for Telo manifests, built on JSON Schema with optional inheritance and CEL-based business rules.

## Why use this

- **Reusable schemas** — define a shape once and reference it by name from every producer and consumer.
- **Schema composition** — `extends` merges parent types property-by-property and accumulates required fields.
- **Business invariants** — CEL `rules` augment structural validation with predicates that fire after the JSON Schema check.
- **Analyzer-aware** — referenced types feed CEL type-checking and editor autocomplete for any field annotated `x-telo-ref: "telo#Type"`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Type.JsonSchema` | Declare a reusable named type from a JSON Schema body, optional `extends`, and optional CEL `rules`. |

## Example

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
---
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

## Schema details

The `schema` field is validated with the standard JSON Schema dialect the analyzer ships with (Draft-07 features plus common Draft-2020-12 keywords). Everything you would put in an inline schema works here.

Any field annotated `x-telo-ref: "telo#Type"` accepts a type name as a string. The analyzer follows the reference, expands the schema, and validates the CEL expressions that feed the script against the declared input shape.

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

## Referencing a type from another schema (`$ref`)

A whole `inputType` / `outputType` can name a type by string (`inputType: User`). To reuse a type as a **fragment** inside a larger JSON Schema — say a shared filter grammar referenced by several definitions — use a standard JSON Schema `$ref` to its module-scoped URI:

```yaml
kind: Type.JsonSchema
metadata: { name: MetadataFilter }
schema: { type: object, additionalProperties: true }
---
kind: Telo.Definition
metadata: { name: Match }
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      filter: { $ref: "telo://Self/MetadataFilter" }   # this module's own type
```

The authority before `#`/`/` is an **import** (or `Self`), not a hardcoded identity:

- `telo://Self/<name>` — a type declared in the same module.
- `telo://<Alias>/<name>` — a type the module imports under `<Alias>` (the imported library must export it). The version is taken from the `imports:` entry, never written in the URI.

Each `Type.JsonSchema` registers its schema under the canonical id `telo://<module>/<name>`; the loader rewrites the `Self`/alias authority to that id before validation. A ref that resolves to no registered type is a static error (`SCHEMA_TYPE_REF_UNRESOLVED` / `SCHEMA_TYPE_REF_UNKNOWN_ALIAS`), so typos surface in `telo check` rather than passing silently. Recursive references within a type's own schema use a plain fragment (`$ref: "#"` / `$ref: "#/$defs/X"`).

## Usage patterns

- **Input/output contracts for scripts** — define `inputType` / `outputType` once, reference from `JavaScript.Script` / `Starlark.Script`.
- **HTTP schemas** — refer to a named type from a route's `schema.body` or `schema.query` to keep the OpenAPI output aligned with internal types.
- **Shared vocabularies** — a dedicated type module (`Telo.Library`) lets multiple applications import the same `User`, `Order`, `Invoice` types without duplication.
