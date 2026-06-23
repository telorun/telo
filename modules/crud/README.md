# CRUD

A complete REST CRUD API over a SQL table as a single declarative resource. `Crud.Resource` is a `Telo.Mount`: give it a `Sql.Connection`, the resource's `singular`/`plural` names, and a `model`, mount it on an `Http.Server`, and you get list / read / create / update / delete routes — no handler wiring, no controller code.

## Why use this

- **One resource, full REST surface** — `Crud.Resource` expands into the five standard routes; you declare a resource, not a route table.
- **Named once, derived everywhere** — `singular`/`plural` default the table name and the `{…}` path parameter, and name the generated OpenAPI operations (`listTodos`, `getTodo`, …).
- **Purely templated** — it builds parameterized [sql](../sql) statements and mounts them through an [http-server](../http-server) `Http.Api` via the `mount:` template dispatch. Nothing to build or deploy beyond the manifest.
- **Mount it anywhere** — drop it into `Http.Server.mounts` at any path; the collection lives at the mount root and `{<idParam>}` items hang off it.

## Routes

Mounted at `<prefix>`, against the table's `id` primary key. `<idParam>` is the configurable item path parameter (default `<singular>Id`, e.g. `todoId`):

| Method & path | Operation | operationId |
| --- | --- | --- |
| `GET <prefix>` | List all rows. | `list<Plural>` |
| `GET <prefix>/{<idParam>}` | Read one row (404 if absent). | `get<Singular>` |
| `POST <prefix>` | Create a row from the JSON body. | `create<Singular>` |
| `PUT <prefix>/{<idParam>}` | Update the columns present in the JSON body (404 if absent). | `update<Singular>` |
| `DELETE <prefix>/{<idParam>}` | Delete a row (204, or 404 if absent). | `delete<Singular>` |

All five share the `<plural>` OpenAPI tag.

## Schema

| Field | Required | Description |
| --- | --- | --- |
| `connection` | yes | `!ref` to a `Sql.Connection` (e.g. a `SqlSqlite.Connection`). |
| `singular` | yes | Singular noun for one item (e.g. `todo`). Defaults `idParam` to `<singular>Id` and names the per-item OpenAPI operations. |
| `plural` | yes | Plural noun for the collection (e.g. `todos`). Defaults `table`; names the list operation and the OpenAPI tag. |
| `model` | yes | A `Type.JsonSchema` (inline or `!ref`) describing the writable columns. Validates request bodies and feeds the OpenAPI document. |
| `table` | no | Database table name. Defaults to `plural`. Its primary key must be the column `id`. |
| `idParam` | no | Name of the `{…}` path parameter for one item. Defaults to `<singular>Id`. The PK column stays `id`; this only renames the URL parameter. |

## Validation

`model` is the data shape of the resource — a [`Type.JsonSchema`](../type) giving each writable column a JSON Schema. It drives request-body validation at the HTTP boundary:

- **`POST`** validates the body against the full model — required fields must be present, and (with `additionalProperties: false`) unknown fields are rejected. A bad body returns `400` before any SQL runs.
- **`PUT`** validates against a *partial* of the model — the same column types, but nothing required — so any subset of columns is accepted while still type-checking each one.

## Column naming

Model properties are the camelCase API names; the database column is each property's **snake_case** form — `dueDate` ↔ `due_date`. Writes translate the property names to columns; reads alias the columns back (`SELECT due_date AS dueDate`), so responses stay in the model's casing. Single-word lowercase names (`text`, `done`) are unchanged. The primary key is always the column `id`.

Exclude `id` from the model: it is the auto-increment primary key, surfaced as the `{<idParam>}` path parameter, never part of a write body. Because `model` reuses `Type.JsonSchema`, it also composes with `extends` (inherit a shared base shape) — the resolved schema is threaded into the routes whole.

## Example

```yaml
kind: Telo.Application
metadata: { name: todo-api, version: 1.0.0 }
imports:
  Http: std/http-server@<version>
  Sql: std/sql@<version>
  SqlSqlite: std/sql-sqlite@<version>
  Type: std/type@<version>
  Crud: std/crud@<version>
targets:
  - !ref Server
ports:
  http: { env: PORT, default: 8077 }
---
kind: SqlSqlite.Connection
metadata: { name: Db }
file: ./todos.db
---
kind: Type.JsonSchema
metadata: { name: TodoModel }
schema:
  type: object
  required: [ text ]
  additionalProperties: false
  properties:
    text: { type: string, minLength: 1 }
    done: { type: integer, enum: [ 0, 1 ] }
---
kind: Crud.Resource
metadata: { name: Todos }
connection: !ref Db
singular: todo
plural: todos
model: !ref TodoModel
---
kind: Http.Server
metadata: { name: Server }
host: 127.0.0.1
port: !cel "ports.http"
mounts:
  - path: /api/todos
    mount: !ref Todos
```

`POST /api/todos` with `{"text":"Buy milk"}` inserts a row; `GET /api/todos` lists them; `PUT /api/todos/1` with `{"done":1}` updates it; `DELETE /api/todos/1` removes it.

## Conventions & limits

- The primary key column is assumed to be named `id`, surfaced as the configurable `{<idParam>}` path parameter (default `<singular>Id`). `idParam` renames only the URL parameter, not the column.
- Set `openapi:` on the `Http.Server` to emit the documented spec — operations are named from `singular`/`plural` (`listTodos`, `getTodo`, …) and tagged with `plural`. Response schemas are not yet named (the `model` excludes `id`, so the response shape differs from the write model).
- Columns are the **snake_case** form of the model's camelCase properties (see *Column naming*). `Crud.Resource` does not create or migrate the table — declare it with `Sql.Migrations` (or your own DDL), naming the columns in snake_case to match.
- For bespoke queries (joins, computed columns, custom status logic) reach for an `Http.Api` with `Sql.Query` handlers directly; `Crud.Resource` covers the common single-table case.
