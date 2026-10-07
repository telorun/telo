# CRUD

A complete REST API over a SQL table as a single declarative resource, and an admin screen over it as a second. `Crud.Resource` is a mount: give it a `Sql.Connection`, the resource's `singular` / `plural` names and a `model`, mount it on an `Http.Server`, and you get list / read / create / replace / delete routes with no handler wiring. `Crud.Ui` turns the same model into a filter bar, a data grid and a form.

## Why use this

- **One resource, full REST surface** — you declare a resource, not a route table.
- **A list route that is a real collection** — cursor paging, sorting, filtering by equality, text, comparison and membership, and a total count, with a 400 that names the bad parameter.
- **Values in the model's types** — a `boolean` property is `true` / `false` on every route and every engine.
- **Named once, derived everywhere** — `singular` / `plural` default the table name and the `{…}` path parameter, and name the OpenAPI operations (`listTodos`, `getTodo`, …).
- **The admin screen in one line** — `Crud.Ui` needs the model and the path, and whatever it produces can be written by hand when you need more.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`Crud.Resource`](docs/resource.md) | The five routes over one table. |
| [`Crud.Ui`](docs/ui.md) | A filter bar, table and form over a collection. |

The list route's query, response and refusals are in [The list route](docs/list-route.md).

## Routes

Mounted at `<prefix>`, against the table's `id` primary key. `<idParam>` is the item path parameter (default `<singular>Id`, e.g. `todoId`):

| Method & path | Operation | operationId |
| --- | --- | --- |
| `GET <prefix>` | One page of rows: `{ rows, total, next }`. | `list<Plural>` |
| `GET <prefix>/{<idParam>}` | Read one row (404 if absent). | `get<Singular>` |
| `POST <prefix>` | Create a row from the JSON body. | `create<Singular>` |
| `PUT <prefix>/{<idParam>}` | Replace the row with the JSON body — a whole record; a property it leaves out is cleared (404 if absent). | `update<Singular>` |
| `DELETE <prefix>/{<idParam>}` | Delete a row (204, or 404 if absent). | `delete<Singular>` |

## Example

```yaml
kind: Telo.Application
metadata: { name: TodoApi, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server
  SQLite: oci://ghcr.io/telorun/sqlite
  Crud: oci://ghcr.io/telorun/crud
  UiReact: oci://ghcr.io/telorun/ui-react
targets:
  - !ref server
ports:
  http: { env: PORT, default: 8077 }
variables:
  dbFile: { env: DB_FILE, type: string, x-telo-type: Telo.HostPath, default: ./todos.db }
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: Telo.JsonSchema
metadata: { name: Todo }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties:
    text: { type: string, minLength: 1 }
    isDone: { type: boolean }
---
kind: Crud.Resource
metadata: { name: todos }
connection: !ref db
singular: todo
plural: todos
model: !ref Todo
---
kind: UiReact.App
metadata: { name: admin }
title: Todos
pages:
  - path: /
    title: Todos
    children:
      - type: composite
        ref: { kind: Crud.Ui, model: !ref Todo, basePath: /api/todos }
---
kind: Http.Server
metadata: { name: server }
host: 127.0.0.1
port: !cel "ports.http"
mounts:
  - { path: /api/todos, mount: !ref todos }
  - { path: /, mount: !ref admin }
```

`POST /api/todos` with `{"text":"Buy milk"}` inserts a row; `GET /api/todos?isDone=false&sort=-id&limit=10` lists a page of them; `PUT /api/todos/1` with `{"text":"Buy milk","isDone":true}` replaces one; `DELETE /api/todos/1` removes it. The same four happen from the screen at `/`.

## Conventions & limits

- The primary key column is `id`, surfaced as the `{<idParam>}` path parameter. `idParam` renames only the URL parameter.
- Columns are the snake_case form of the model's camelCase properties. `Crud.Resource` does not create or migrate the table — declare it with your engine's `Table` / `Schema` kinds.
- The two read routes and the update route run on SQLite and PostgreSQL. The create and delete routes build their statements with `?` placeholders, which is SQLite's spelling.
- `POST` and `PUT` bodies are validated against the whole model; a refused one is a 400 naming the property.
- A read returns a record valid against the model, so it can be sent back: a column holding `NULL` is `null` where the property admits it, left out where the property is optional, and the type's empty value (`""`, `0`, `false`) where it is required. See [What a read returns](docs/resource.md#what-a-read-returns).
- Set `openapi:` on the `Http.Server` to emit the spec. The list response is documented as its envelope; a row's own properties are not yet named in it.
- For joins, computed columns or custom status logic, write an `Http.Api` with `Sql.Query` handlers; `Crud.Resource` covers the single-table case.
