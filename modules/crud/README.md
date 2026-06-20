# CRUD

A complete REST CRUD API over a SQL table as a single declarative resource. `Crud.Resource` is a `Telo.Mount`: give it a `Sql.Connection` and a table, mount it on an `Http.Server`, and you get list / read / create / update / delete routes — no handler wiring, no controller code.

## Why use this

- **One resource, full REST surface** — `Crud.Resource` expands into the five standard routes; you declare a table, not a route table.
- **Purely templated** — it composes [sql-repository](../sql-repository)'s SQL handlers with an [http-server](../http-server) `Http.Api` through the `mount:` template dispatch. Nothing to build or deploy beyond the manifest.
- **Mount it anywhere** — drop it into `Http.Server.mounts` at any path; the collection lives at the mount root and `{id}` items hang off it.

## Routes

Mounted at `<prefix>`, against the table's `id` primary key:

| Method & path | Operation |
| --- | --- |
| `GET <prefix>` | List all rows. |
| `GET <prefix>/{id}` | Read one row (404 if absent). |
| `POST <prefix>` | Create a row from the JSON body. |
| `PUT <prefix>/{id}` | Update the columns present in the JSON body (404 if absent). |
| `DELETE <prefix>/{id}` | Delete a row (204, or 404 if absent). |

## Schema

| Field | Required | Description |
| --- | --- | --- |
| `connection` | yes | `!ref` to a `Sql.Connection` (e.g. a `SqlSqlite.Connection`). |
| `table` | yes | Table name. Its primary key must be the column `id`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: todo-api, version: 1.0.0 }
imports:
  Http: std/http-server@<version>
  Sql: std/sql@<version>
  SqlSqlite: std/sql-sqlite@<version>
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
kind: Crud.Resource
metadata: { name: Todos }
connection: !ref Db
table: todos
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

- The primary key column is assumed to be named `id` and surfaced as the `{id}` path parameter.
- Request bodies are passed through verbatim to the table columns — JSON fields map one-to-one to columns, so validate the body shape with the route's request schema if you need stricter input rules upstream.
- For bespoke queries (joins, computed columns, custom status logic) reach for an `Http.Api` with `Sql.Query` handlers directly; `Crud.Resource` covers the common single-table case.
