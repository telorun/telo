# SQL Repository

Domain-shaped CRUD over a table. `SqlRepository.Read`, `SqlRepository.Create`, and `SqlRepository.Delete` each take a table name and a connection and expose a typed invocable whose inputs describe the operation in domain terms (`filters`, `data`) rather than SQL.

The module has no controllers — each kind is a parameterized template that expands into one or more `Sql.Query` / `Sql.Exec` resources at load time. That means everything you know about `Sql` (connections, transactions, bindings, result shape) carries over directly.

---

## SqlRepository.Read

Reads rows from a table filtered by an equality map.

```yaml
kind: SqlRepository.Read
metadata:
  name: FindUsers
connection:
  kind: Sql.Connection
  name: Db
table: users
```

Invoke with a `filters` object — each key becomes an `= ?` predicate joined with `AND`. An empty `filters` selects every row.

```yaml
handler:
  kind: SqlRepository.Read
  name: FindUsers
inputs:
  filters:
    email: "${{ request.query.email }}"
    status: active
```

Generated query (shape):

```sql
SELECT * FROM users WHERE email = ? AND status = ?
```

Result: the same `{ rows, rowCount }` shape as `Sql.Query`.

---

## SqlRepository.Create

Inserts a row from a domain object.

```yaml
kind: SqlRepository.Create
metadata:
  name: InsertUser
connection:
  kind: Sql.Connection
  name: Db
table: users
```

```yaml
handler:
  kind: SqlRepository.Create
  name: InsertUser
inputs:
  data:
    email: "${{ request.body.email }}"
    status: pending
```

Generated statement (shape):

```sql
INSERT INTO users (email, status) VALUES (?, ?)
```

---

## SqlRepository.Delete

Removes rows matching an equality map.

```yaml
kind: SqlRepository.Delete
metadata:
  name: RemoveUser
connection:
  kind: Sql.Connection
  name: Db
table: users
```

```yaml
handler:
  kind: SqlRepository.Delete
  name: RemoveUser
inputs:
  filters:
    id: "${{ request.params.id }}"
```

Generated statement (shape):

```sql
DELETE FROM users WHERE id = ?
```

A `Delete` without filters would generate `DELETE FROM users WHERE` — which is invalid SQL. Make sure every invocation supplies at least one filter.

---

## When to use it

`SqlRepository.*` is designed for straightforward CRUD — HTTP routes that front a single table, admin panels, simple internal APIs. When you need joins, aggregates, `OR` groups, `LIKE` predicates, paging, or anything beyond strict equality, drop down to [`Sql.Select`](../sql/select.md) or `Sql.Query` directly.

Because each repository kind expands into ordinary `Sql.*` resources, it participates in transactions exactly like hand-written SQL — wrap a sequence in `Sql.Transaction` and the generated invocations pick up the active transaction automatically.
