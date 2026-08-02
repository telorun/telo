# SQL Repository

Domain-shaped CRUD over a single table. Each kind takes a `table` and a `connection` and exposes a typed invocable whose inputs describe the operation in domain terms (`filters`, `data`) instead of raw SQL.

## Why use this

- **Domain-shaped inputs** — pass `filters` or `data` objects; the module generates parameterized SQL.
- **No new controllers** — each kind is a parameterized template that expands into `Sql.Query` / `Sql.Command` resources at load time.
- **Transaction-aware** — generated invocations honour `Sql.Transaction` via `AsyncLocalStorage` exactly like hand-written SQL.
- **Straightforward CRUD** — ideal for HTTP routes fronting a single table, admin panels, and simple internal APIs.

## Kinds

| Kind | Purpose |
| --- | --- |
| `SqlRepository.Read` | Reads rows from a table filtered by an equality map. |
| `SqlRepository.Create` | Inserts a row from a domain object. |
| `SqlRepository.Update` | Updates the columns in a `data` map for rows matching a `filters` map. |
| `SqlRepository.Delete` | Removes rows matching an equality map. |

## Example

```yaml
kind: Telo.Application
metadata: { name: users-api, version: 1.0.0 }
imports:
  Sql: oci://ghcr.io/telorun/sql@0.13.0
  SqlRepository: oci://ghcr.io/telorun/sql-repository@0.7.0
secrets:
  DATABASE_URL: { env: DATABASE_URL, type: string }
---
kind: Sql.Connection
metadata: { name: Db }
connectionString: !cel "secrets.DATABASE_URL"
---
kind: SqlRepository.Read
metadata: { name: FindUsers }
connection: !ref Db
table: users
---
kind: SqlRepository.Create
metadata: { name: InsertUser }
connection: !ref Db
table: users
---
kind: SqlRepository.Delete
metadata: { name: RemoveUser }
connection: !ref Db
table: users
```

Invoke from a handler step:

```yaml
handler:
  kind: SqlRepository.Read
  name: FindUsers
inputs:
  filters:
    email: !cel "request.query.email"
    status: active
```

## When to Use It

`SqlRepository.*` is designed for straightforward CRUD. When you need joins, aggregates, `OR` groups, `LIKE` predicates, paging, or anything beyond strict equality, drop down to [`Sql.Selection`](../sql/selection.md) or `Sql.Query` directly. A `SqlRepository.Delete` without filters would generate invalid SQL (`DELETE FROM users WHERE`) — make sure every invocation supplies at least one filter.
