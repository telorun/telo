---
sidebar_label: Templated Definitions
slug: /extend/templated-definitions
description: Define a new resource kind without writing a controller — compose existing kinds declaratively with a dispatch body (resources, invoke/provide/run/mount, inputs, result).
---

# Templated definitions

A `Telo.Definition` does not always need a controller. When your new kind is a **composition of kinds that already exist**, you can build it entirely in YAML: declare the internal resources it wires up, and delegate its capability method to one of them. There is no code, the kind stays fully visual in the editor, and it remains statically analyzable.

This is the *templated* form of a definition. It is the counterpart to the controller-backed form in [Authoring a Module](/extend/authoring-a-module): same `Telo.Definition` document, but instead of `controllers:` pointing at a package, a **dispatch body** describes how to assemble and run the instance.

## Templated vs. controller-backed

| Reach for a template when… | Reach for a controller when… |
|---|---|
| the behaviour is a composition of existing kinds (a SQL query, an HTTP call, a cache lookup) | you need a Node/Rust API the kernel doesn't expose yet |
| it's reusable and you want it type-safe at the manifest level | the logic is novel runtime behaviour, not a wiring of existing kinds |
| you want it editable and analyzable without shipping a package | you need imperative control the template engine can't express |

Templates are the preferred extension path whenever they fit — see the `JS.Script`-is-a-last-resort guidance in `CLAUDE.md`: before writing code, check whether the work is a composition that belongs in a generic templated kind.

## Anatomy

A templated definition omits `controllers:` and instead supplies:

| Field | Role |
|---|---|
| `capability` | still required — the lifecycle role the instance fulfils (`Telo.Invocable`, `Telo.Provider`, `Telo.Runnable`, `Telo.Mount`) |
| `schema` | the kind's config; `self` is typed from it |
| `inputType` / `outputType` | the invocation contract (Invocable / Runnable) |
| `resources` | internal sub-resources instantiated per outer instance — the kinds the template composes |
| `invoke:` / `provide:` / `run:` / `mount:` | the **dispatch target** — names which internal resource fulfils the capability |
| `inputs` | top-level sibling — the values passed *to* the dispatch target |
| `result` | top-level sibling — post-call mapping applied to the target's output |
| `extends` | the `Telo.Abstract` this kind implements (optional) |

The dispatch field, `inputs`, and `result` are **top-level siblings** on the definition — the same `{ name, inputs, invoke }` factoring used by `Run.Sequence` steps.

## Invocable template

Compose a `Sql.Query` into a reusable `Read` kind. Each `Read` instance owns its own query resource (named from `self.name` so instances don't collide), delegates `invoke()` to it, and feeds it SQL built from the instance's config and the caller's inputs:

```yaml
kind: Telo.Definition
metadata:
  name: Read
capability: Telo.Invocable
schema:
  type: object
  required: [connection, table]
  properties:
    connection:
      x-telo-ref: "std/sql#Connection"
    table:
      type: string
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    properties:
      filters: { type: object, additionalProperties: true }
    required: [filters]
resources:
  - kind: Sql.Query
    metadata:
      name: !cel "self.name + '-query'"
    connection: !cel "self.connection"
invoke:
  kind: Sql.Query
  name: !cel "self.name + '-query'"
inputs:
  sql: !cel "'SELECT * FROM ' + self.table + (keys(inputs.filters).size() > 0 ? ' WHERE ' + join(keys(inputs.filters).map(k, k + ' = ?'), ' AND ') : '')"
  bindings: !cel "keys(inputs.filters).map(k, inputs.filters[k])"
```

- `resources` declares the internal `Sql.Query`. CEL here sees `self` (this instance's config).
- `invoke` points at that internal resource by `kind` + `name`.
- `inputs` is what gets passed to the `Sql.Query`. Inside it, CEL sees both `self` and `inputs` (the caller's arguments to `Read`).

## Provider template

A provider composes a source kind and shapes its output. `provide()` takes no caller arguments, so the body sees only `self`. The top-level `result` maps the target's output into the shape required by the `extends`-declared abstract:

```yaml
kind: Telo.Definition
metadata:
  name: TokenProvider
capability: Telo.Provider
extends: Auth.Credential
schema:
  type: object
  required: [secret]
  properties:
    secret: { type: string }
resources:
  - kind: JavaScript.Script
    metadata:
      name: !cel "self.name + '-source'"
    inputType: { type: object, additionalProperties: true }
    outputType: { type: object, additionalProperties: true }
    code: |
      function main(input) { return { raw: input.value } }
provide:
  kind: JavaScript.Script
  name: !cel "self.name + '-source'"
inputs:
  value: !cel "self.secret"
result:
  token: !cel "'bearer ' + result.raw"
```

- `provide` names the dispatch target.
- `inputs` feeds it (`self` only — no `inputs` variable for providers).
- `result` rewrites the target's output. Inside `result`, CEL sees `result`, typed from the dispatch target's `outputType`; the produced value is validated against the `outputType` of the abstract this kind `extends`.

## Mount template

A `Telo.Mount` template declares an internal mountable surface (typically an `Http.Api`) plus any handlers it needs, then names the surface with `mount:`. `modules/crud` is the canonical example — `Crud.Resource` builds four SQL handlers and one `Http.Api`, all from `self`:

```yaml
kind: Telo.Definition
metadata:
  name: Resource
capability: Telo.Mount
schema:
  type: object
  required: [connection, table]
  properties:
    connection: { x-telo-ref: "std/sql#Connection" }
    table: { type: string }
resources:
  - kind: Self.Reader          # internal handler kinds, also templated
    metadata: { name: reader }
    connection: !cel "self.connection"
    table: !cel "self.table"
  - kind: Http.Api
    metadata: { name: api }
    routes:
      - request: { method: GET, path: / }
        handler: !ref reader
        returns:
          - status: 200
            content:
              application/json:
                body: !cel "result.rows"
mount: api
```

See [`modules/crud/telo.yaml`](https://github.com/telorun/telo/blob/main/modules/crud/telo.yaml) for the full CRUD surface.

## CEL scopes inside a template

| Variable | Typed from | Available in |
|---|---|---|
| `self` | this definition's `schema` | everywhere — `resources`, `inputs`, `result`, and CEL in `schema` |
| `inputs` | `inputType` (or the `extends` abstract's `inputType`) | `resources` and top-level `inputs` — **Invocable / Runnable only** |
| `result` | the dispatch target's `outputType` | top-level `result` |

The analyzer validates every expression against these scopes statically, so a typo like `self.tabel` or `inputs.fitlers` is a load-time error, not a runtime surprise.

## `extends` and `Self`

`extends` declares the [`Telo.Abstract`](/reference/kernel/inheritance) this kind implements (e.g. `Auth.Credential` above). The prefix is an import alias, or **`Self`** — auto-registered to point at the declaring library's own module — when the abstract or composed kind lives in the same library. `Self.<Kind>` lets a template compose or implement a sibling kind without an import (a self-import would loop the loader), and resolves ungated, independent of `exports.kinds`. The CRUD example uses `Self.Reader` to compose its own internal handler kind.

## See also

- [Resource Definition](/reference/kernel/resource-definition) — every `Telo.Definition` field and `x-telo-*` annotation, including the no-controller execution rule.
- [Inheritance](/reference/kernel/inheritance) — `Telo.Abstract`, `extends`, and `Self`.
- [Authoring a Module](/extend/authoring-a-module) — the controller-backed path, for behaviour a template can't express.
- `modules/crud` and `modules/sql-repository` — real templated modules.
