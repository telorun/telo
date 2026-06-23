# Crud model: request validation

## Goal

Give `Crud.Resource` a **model** — the data shape of the resource, reusing
`Type.JsonSchema` from the [`type`](../../type/telo.yaml) module — and validate
request bodies against it: POST/PUT bodies are checked against the model's JSON
Schema (structural validation at the HTTP boundary, plus OpenAPI).

Today `Crud.Resource` takes only `connection` + `table`, and bodies are passed
through verbatim (`body: { type: object }` — accepts anything).

Table/migration generation from the model is **out of scope here** — it will be
handled separately.

## Design

### 1. `model` field on `Crud.Resource`

Add a `model` property to the `Crud.Resource` schema, shaped exactly like the
established `inputType` / `outputType` slots (`x-telo-ref: "telo#Type"`,
see [javascript/telo.yaml:29](../../javascript/telo.yaml#L29)). It accepts either
an inline `Type.JsonSchema` or a `!ref` to a shared one:

```yaml
# inline
kind: Crud.Resource
metadata: { name: Todos }
connection: !ref Db
table: todos
model:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [text]
    additionalProperties: false
    properties:
      text: { type: string, minLength: 1 }
      done: { type: integer, enum: [0, 1], default: 0 }
```

```yaml
# shared / reusable
kind: Type.JsonSchema
metadata: { name: Todo }
schema: { type: object, required: [text], properties: { text: {type: string}, done: {type: integer} } }
---
kind: Crud.Resource
metadata: { name: Todos }
connection: !ref Db
table: todos
model: !ref Todo
```

`model` is **required** — every `Crud.Resource` declares its shape.

**Convention:** the model describes the **writable columns only** — it excludes
`id`. `id` stays the auto-increment primary key and the `{id}` path parameter,
typed by the existing `params` schema. POST/PUT bodies therefore never carry
`id`.

### 2. Surfacing the model's schema to the template

The blocker: a `Type.JsonSchema` instance does not expose its schema —
[type/index.ts](../../type/nodejs/src/index.ts) registers it in the kernel
schema registry and returns an instance that only validates rules. After Phase 5
injection, `self.model` is that instance, so `${{ self.model.schema }}` resolves
to `undefined`. We need the resolved JSON Schema readable from the template's
`self`.

**Approach:** expose the **fully-resolved effective schema** as readable instance
state on `TypeResource` ([type/index.ts](../../type/nodejs/src/index.ts)), so
`${{ self.model.schema }}` navigates to a self-contained JSON object — no
external `$ref`s, all `extends` parents merged in (see below). The crud template
threads it straight into Fastify with no bundling step, and any `!ref`'d named
schema becomes readable beyond crud. It touches a shared module's runtime, so it
needs a changeset on `@telorun/type`. The rest of the design reads the schema as
`self.model.schema`.

#### Handling `extends`

Today the type controller represents `extends` as an `allOf` wrapper with `$ref`s
to the parents: `{ allOf: [{ $ref: "Parent" }, ownSchema] }`
([type/index.ts:55](../../type/nodejs/src/index.ts#L55)). Two problems for crud:
the `$ref`s aren't resolvable inside Fastify's AJV, and `allOf` +
`additionalProperties: false` is the classic JSON-Schema footgun (each branch
independently rejects the other branch's properties). The PUT partial also reads
`self.model.schema.properties`, which an `allOf` shape has no top-level
`properties` for.

Fix it at the source: resolve `extends` into a **deep-merged, self-contained
object schema** instead of an `allOf` wrapper. Merge each parent's *effective*
schema (already resolved, so the merge is transitive through grandparents), then
the own schema, on top:

- `properties` — union; the more-derived (child) wins on a key conflict.
- `required` — union across all levels.
- `additionalProperties` — the most-derived value that sets it (so a child's
  `additionalProperties: false` takes effect cleanly); else inherited; else the
  default.
- other top-level keywords (`type`, …) — child wins.

The result has no `$ref`s and a single top-level `properties` / `required`, so
POST validates correctly (footgun gone), the PUT partial reads real merged
properties, and the analyzer still types it. This changes the registered schema
for every `extends` type **module-wide** — a deliberate improvement over the
`allOf` form; verify the `type` and analyzer test suites still pass. (If a
module-wide change is unwanted, the fallback is to keep the registry `allOf` and
expose the merged form as a separate instance accessor — but the merged form is
the better canonical representation.)

### 3. Threading validation into the routes

The route's `request.schema.body` is already a real Fastify/AJV validation slot
that is also rendered into OpenAPI ([http-dispatch Matcher](../../http-dispatch/telo.yaml#L57-L83));
today the crud template fills it with `{ type: object }`. The template's
`expandSelf` resolves a pure `self.<path>` by direct navigation
([resource-template-controller.ts:157](../../../kernel/nodejs/src/controllers/resource-definition/resource-template-controller.ts#L157)),
so a `${{ self.model.schema }}` leaf lands the schema object verbatim into the
route. Per HTTP verb:

- **POST (create):** `body: !cel "self.model.schema"` — full schema, `required`
  enforced, `additionalProperties: false` (as declared on the model).
- **PUT (update, partial / PATCH-style):** rebuild a required-less schema —
  JSON Schema can't "un-require" via composition (works for `extends` models too,
  since the schema is already flattened — §2):
  ```yaml
  schema:
    body:
      type: object
      additionalProperties: false
      properties: !cel "self.model.schema.properties"
  ```
- **GET read / list (optional):** attach `${{ self.model.schema }}` (+ `id`) as
  the `returns[].content.application/json.schema` for OpenAPI completeness.
  Responses are currently unvalidated raw rows; this is cosmetic and can be a
  follow-up.

Analyzer note: inside the crud library the route body becomes a CEL expression
rather than a literal schema, so `request.body.*` stays untyped `dyn` there. The
template only uses `request.body` wholesale (`data: ${{ request.body }}`), so no
field access and no analyzer error. Verify the loader compiles `${{ }}` at this
nesting depth (it compiles `connection`/`table` today — expected to hold).

## Implementation steps

1. In `@telorun/type`, resolve `extends` into a deep-merged, self-contained
   object schema and expose it on `TypeResource` as readable state, so
   `${{ self.model.schema }}` navigates (changeset; verify type + analyzer tests).
2. Add the required `model` field (`x-telo-ref: "telo#Type"`) to the
   `Crud.Resource` schema (`required: [connection, table, model]`).
3. Thread the schema into route `request.schema.body` (POST full, PUT partial).
4. Update the test [crud-over-http.yaml](../tests/crud-over-http.yaml): add a
   `model`, assert a malformed POST/PUT is rejected (400).
5. Run `pnpm run test`.

## Out of scope / follow-ups

- **Table / migration generation from the model.** Handled separately — this
  plan only validates requests against the model.
- **CEL `rules` enforcement.** Reusing `Type.JsonSchema` brings business-invariant
  `rules`, but Fastify only runs structural JSON Schema — `rules` would need an
  explicit validate step in the request path. The user's ask is JSON-Schema
  validation, which the route schema covers; `rules` is a later add.

## Docs & versioning

- `modules/crud/docs/` + [README](../README.md): document `model` and the
  writable-columns/`id` convention. Wire any new doc into
  `pages/docusaurus.config.ts` + `pages/sidebars.ts`.
- changie fragment for `crud` (`changie new --project crud`, `Added`).
- changeset for `@telorun/type` (resolve `extends` to a merged schema + expose it).
