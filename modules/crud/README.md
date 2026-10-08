# CRUD

A complete REST API over a SQL table as a single declarative resource, and an admin screen over it as a second. `Crud.Resource` is a mount: give it a `Sql.Connection`, the resource's `singular` / `plural` names and a `model`, mount it on an `Http.Server`, and you get list / read / create / replace / delete routes with no handler wiring. A `Crud.Model` names the record's shape for each operation and what the list may be filtered and sorted by, and `Crud.Ui` turns the same model into a filter bar, a data grid and its forms.

## Why use this

- **One resource, full REST surface** — you declare a resource, not a route table.
- **A list route that is a real collection** — cursor paging, sorting, filtering by equality, text, comparison and membership, and a total count, with a 400 that names the bad parameter.
- **Only declared queries** — the model lists the filters and sorts the list accepts; the API refuses the rest and the screen offers exactly those, so nobody queries by a column you did not index.
- **A shape per operation** — what a client creates, what it updates, what one record reads as and what a list row holds are four named shapes, so a server-set column is read-only and a list can leave a heavy one out.
- **Writes answer with the stored record** — the key the table assigned and every value it filled in.
- **Values in their declared types** — a `boolean` property is `true` / `false` on every route and every engine.
- **Named once, derived everywhere** — `singular` / `plural` default the table name and the `{…}` path parameter, and name the OpenAPI operations (`listTodos`, `getTodo`, …).
- **The admin screen in one line** — `Crud.Ui` needs the model and the path, and whatever it produces can be written by hand when you need more.
- **Presentation without an eject** — three optional keys say how the filter bar behaves (what is on show, where it sits, where its state is kept) and where the create and edit forms open (a dialog, a drawer, a panel, a page), what each does after a save and whether unsaved input is confirmed.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`Crud.Model`](docs/model.md) | The record's shape for each operation — read, list, create, update — and the filters and sorts the list accepts. |
| [`Crud.Resource`](docs/resource.md) | The five routes over one table. |
| [`Crud.Ui`](docs/ui.md) | A filter bar, table and forms over a collection, with optional `filters`, `create` and `edit` presentation. |

The list route's query, response and refusals are in [The list route](docs/list-route.md).

## Routes

Mounted at `<prefix>`, against the table's `id` primary key. `<idParam>` is the item path parameter (default `<singular>Id`, e.g. `todoId`):

| Method & path | Operation | operationId |
| --- | --- | --- |
| `GET <prefix>` | One page of rows: `{ rows, total, next }`. | `list<Plural>` |
| `GET <prefix>/{<idParam>}` | Read one record (404 if absent). | `get<Singular>` |
| `POST <prefix>` | Create a row from the JSON body; answers with the stored record. | `create<Singular>` |
| `PUT <prefix>/{<idParam>}` | Replace what the update shape declares of the row — a property of it the body leaves out is cleared, every other column is kept; answers with the stored record (404 if absent). | `update<Singular>` |
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
# What a client writes.
kind: Telo.JsonSchema
metadata: { name: TodoDraft }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties:
    text: { type: string, minLength: 1 }
    isDone: { type: boolean }
---
# What is read back: the draft plus the key.
kind: Telo.JsonSchema
metadata: { name: Todo }
extends: TodoDraft
schema:
  type: object
  required: [id]
  properties:
    id: { type: integer }
---
kind: Crud.Model
metadata: { name: todoModel }
schemas:
  read: !ref Todo
  list: !ref Todo
  create: !ref TodoDraft
  update: !ref TodoDraft
query:
  filters:
    - { property: text, operator: contains }
    - { property: isDone, operator: eq }
  sort:
    - { property: text }
---
kind: Crud.Resource
metadata: { name: todos }
connection: !ref db
singular: todo
plural: todos
model: !ref todoModel
---
kind: UiReact.App
metadata: { name: admin }
title: Todos
pages:
  - path: /
    title: Todos
    children:
      - type: composite
        ref: { kind: Crud.Ui, model: !ref todoModel, basePath: /api/todos }
---
kind: Http.Server
metadata: { name: server }
host: 127.0.0.1
port: !cel "ports.http"
mounts:
  - { path: /api/todos, mount: !ref todos }
  - { path: /, mount: !ref admin }
```

`POST /api/todos` with `{"text":"Buy milk"}` inserts a row and answers with it, `id` included; `GET /api/todos?isDone=false&sort=-text&limit=10` lists a page of them; `PUT /api/todos/1` with `{"text":"Buy milk","isDone":true}` replaces one; `DELETE /api/todos/1` removes it. The same four happen from the screen at `/`.

`Crud.Ui` also takes `filters:` (the bar's policy), `create:` and `edit:` (each form's `surface`, `afterSubmit` and `unsaved`) — for instance `create: { surface: { kind: Ui.Drawer }, afterSubmit: again }`, with `ui` imported as `Ui`. Each is passed on as written; a key left out takes the table's or the bar's default. See [`Crud.Ui`](docs/ui.md#presentation).

## Conventions & limits

- The list accepts the filters and sorts the model's `query` declares and answers any other with a 400. The generated OpenAPI document types `limit`, `cursor` and `sort`; it does not list the declared filter parameters.
- The primary key column is `id`, declared in the model's `read` and `list` shapes and surfaced as the `{<idParam>}` path parameter. `idParam` renames only the URL parameter.
- Columns are the snake_case form of the shapes' camelCase properties. `Crud.Resource` does not create or migrate the table — declare it with your engine's `Table` / `Schema` kinds.
- Every route but delete runs on SQLite and PostgreSQL; the delete route builds its statement with `?` placeholders, which is SQLite's spelling. A write reads the stored record back with `RETURNING`.
- A `POST` body is validated against the model's `create` shape and a `PUT` body against its `update` shape; a refused one is a 400 naming the property.
- A read returns a record valid against its shape, so it can be sent back: a column holding `NULL` is `null` where the property admits it, left out where the property is optional, and the type's empty value (`""`, `0`, `false`) where it is required. See [What a read returns](docs/resource.md#what-a-read-returns).
- Set `openapi:` on the `Http.Server` to emit the spec, which states each operation's shape: request bodies, the record read, and the rows of the list.
- For joins, computed columns or custom status logic, write an `Http.Api` with `Sql.Query` handlers; `Crud.Resource` covers the single-table case.
