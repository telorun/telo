# CRUD

A complete REST API over a SQL table as a single declarative resource. A `Crud.Collection` names the table the records are stored in, the record's shape for each operation, what the list may be filtered, sorted and faceted by, and which properties point at another collection's records. `Crud.Api` is a mount: give it a `Sql.Connection`, the `singular` / `plural` names and the collection, mount it on an `Http.Server`, and you get list / read / create / replace / delete routes with no handler wiring.

## Why use this

- **One resource, full REST surface** — you declare a resource, not a route table.
- **A list route that is a real collection** — cursor paging, sorting, filtering by equality, text, comparison, membership and absence, and a total count, with a 400 that names the bad parameter.
- **Counts per value** — a facet request answers each value a property holds under the active filters, with how many rows hold it, paged like a list.
- **Only declared queries** — the collection lists the filters, sorts and facets the list accepts; the API refuses the rest, so nobody queries by a column you did not index.
- **A shape per operation** — what a client creates, what it updates, what one record reads as and what a list row holds are four named shapes, so a server-set column is read-only and a list can leave a heavy one out.
- **Checked against the table** — a property with no column, a key that is not the primary key, and a relation its foreign key contradicts are refused before the app runs and again at start.
- **Writes answer with the stored record** — the key the table assigned and every value it filled in.
- **Values in their declared types** — a `boolean` property is `true` / `false` on every route and every engine.
- **Named once, derived everywhere** — `singular` / `plural` name the `{…}` path parameter and the OpenAPI operations (`listTodos`, `getTodo`, …).

## Kinds

| Kind | Purpose |
| --- | --- |
| [`Crud.Collection`](docs/collection.md) | The table, the record's shape for each operation, the filters, sorts and facets the list accepts, and the relations to other collections. A `DataModel.Collection`. |
| [`Crud.Api`](docs/api.md) | The five routes over one collection's table. |

The list route's query, facets, response and refusals are in [The list route](docs/list-route.md).

## Routes

Mounted at `<prefix>`, against the table's `id` primary key. `<idParam>` is the item path parameter (default `<singular>Id`, e.g. `todoId`):

| Method & path | Operation | operationId |
| --- | --- | --- |
| `GET <prefix>` | One page of rows: `{ rows, total, next }`; with `facet=<property>`, one page of its present values: `{ values, next }`. | `list<Plural>` |
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
targets:
  - !ref schema
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
kind: SQLite.Table
metadata: { name: todosTable }
table: todos
columns:
  id: { type: integer, primaryKey: true, identity: always }
  text: { type: text, nullable: false }
  is_done: { type: integer, nullable: false, default: 0 }
---
kind: SQLite.Schema
metadata: { name: schema }
connection: !ref db
version: !cel "module.version"
tables: [!ref todosTable]
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
kind: Crud.Collection
metadata: { name: todos }
model: !ref Todo
table: !ref todosTable
schemas: { list: !ref Todo, create: !ref TodoDraft, update: !ref TodoDraft }
query:
  filters: [{ property: text, operator: contains }, { property: isDone, operator: eq }]
  sort: [{ property: text }]
  facets: [{ property: isDone }]
---
kind: Crud.Api
metadata: { name: todosApi }
connection: !ref db
singular: todo
plural: todos
collection: !ref todos
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - { path: /api/todos, mount: !ref todosApi }
```

`POST /api/todos` with `{"text":"Buy milk"}` inserts a row and answers with it, `id` included; `GET /api/todos?isDone=false&sort=-text&limit=10` lists a page of them; `GET /api/todos?facet=isDone&text.contains=milk` counts the done and open ones among those mentioning milk; `PUT /api/todos/1` with `{"text":"Buy milk","isDone":true}` replaces one; `DELETE /api/todos/1` removes it.

## Conventions & limits

- The list accepts the filters, sorts and facets the collection's `query` declares and answers any other with a 400. The generated OpenAPI document types `limit`, `cursor`, `sort` and `facet`; it does not list the declared filter parameters.
- The primary key column is `id`, declared in `model` and the `list` shape and surfaced as the `{<idParam>}` path parameter. `idParam` renames only the URL parameter.
- Columns are the snake_case form of the shapes' camelCase properties. Neither kind creates or migrates the table — list the collection's table in your engine's `Schema`.
- Every route but delete runs on SQLite and PostgreSQL; the delete route builds its statement with `?` placeholders, which is SQLite's spelling. A write reads the stored record back with `RETURNING`.
- A `POST` body is validated against the collection's `create` shape and a `PUT` body against its `update` shape; a refused one is a 400 naming the property.
- A read returns a record valid against its shape, so it can be sent back: a column holding `NULL` is `null` where the property admits it, left out where the property is optional, and the type's empty value (`""`, `0`, `false`) where it is required. See [What a read returns](docs/api.md#what-a-read-returns).
- Set `openapi:` on the `Http.Server` to emit the spec, which states each operation's shape: request bodies, the record read, and the rows of the list.
- For joins, computed columns or custom status logic, write an `Http.Api` with `Sql.Query` handlers; `Crud.Api` covers the single-table case.
- An admin screen over a collection is the `crud-ui` module's.
