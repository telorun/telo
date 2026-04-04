# Sql.Select

A declarative `SELECT` builder. Expresses query structure as data — columns, filters, ordering, pagination — without writing SQL strings.

Use `Sql.Query` for JOINs, CTEs, subqueries, or anything else that doesn't fit here. For everything else, `Sql.Select` is safer and clearer.

---

## Basic example

```yaml
kind: Sql.Select
metadata:
  name: GetUsers
connection:
  kind: Sql.Connection
  name: Db
from: users
columns: [id, name, email, created_at]
where:
  - { column: deleted_at, op: is_null }
  - { column: status, op: eq, value: active }
orderBy:
  - { column: created_at, direction: desc }
limit: 50
```

---

## `columns`

A list of column names or expressions. Strings are treated as quoted identifiers. Objects allow aliases and raw expressions.

```yaml
columns:
  - id
  - name
  - { column: created_at, as: joined_at } # column alias
  - { expr: "count(*)", as: version_count } # aggregate
  - { expr: "coalesce(description, '')", as: description }
```

`column:` values are double-quoted by the controller — safe to use with user-defined table schemas. `expr:` is passed verbatim — same trust level as `sql:` in `where:`.

Omitting `columns` selects all columns (`SELECT *`).

---

## `where`

A list of clauses implicitly combined with AND. Each clause is identified by its primary key:

| Primary key | Meaning                                    |
| ----------- | ------------------------------------------ |
| `column:`   | Structured condition against an identifier |
| `sql:`      | Raw SQL fragment                           |
| `or:`       | OR group (array of clauses)                |
| `and:`      | AND group (array of clauses)               |
| `not:`      | Negation of a single child clause          |

All clause types accept an optional `when:` boolean. When `when:` evaluates to `false` the clause (and its children) is silently omitted from the query.

### Structured conditions

```yaml
where:
  - { column: status, op: eq, value: published }
  - { column: score, op: gte, value: "${{ inputs.minScore }}" }
  - { column: tags, op: in, value: "${{ inputs.tags }}" }
  - { column: deleted_at, op: is_null }
```

Supported operators:

| Op            | SQL                                          |
| ------------- | -------------------------------------------- |
| `eq`          | `= $N`                                       |
| `ne`          | `<> $N`                                      |
| `lt`          | `< $N`                                       |
| `lte`         | `<= $N`                                      |
| `gt`          | `> $N`                                       |
| `gte`         | `>= $N`                                      |
| `like`        | `LIKE $N`                                    |
| `ilike`       | `ILIKE $N` (Postgres only)                   |
| `in`          | `= ANY($N)` (Postgres) / `IN (...)` (SQLite) |
| `is_null`     | `IS NULL`                                    |
| `is_not_null` | `IS NOT NULL`                                |

To compare a column against another column instead of a bound value, use `ref:` instead of `value:`:

```yaml
- { column: updated_at, op: gt, ref: created_at }
```

### Raw SQL fragments

```yaml
where:
  - sql: "to_tsvector(description) @@ plainto_tsquery($1)"
    bindings: ["${{ inputs.q }}"]
```

Placeholders in `sql:` fragments are always `$1`-based and local to that fragment. The controller renumbers them to fit their position in the global binding array.

### OR and AND groups

Top-level items are implicit AND. Use `or:` or `and:` to change the grouping:

```yaml
where:
  - { column: deleted_at, op: is_null }
  - or:
      - { column: role, op: eq, value: admin }
      - { column: role, op: eq, value: superuser }
  - and:
      - { column: region, op: eq, value: "${{ inputs.region }}" }
      - { column: active, op: eq, value: true }
```

Generated:

```sql
WHERE deleted_at IS NULL
  AND (role = $1 OR role = $2)
  AND (region = $3 AND active = $4)
```

### `not:`

Wraps any single child clause in `NOT (...)`. The child can be a condition, group, raw fragment, or another `not:`:

```yaml
where:
  - not:
      or:
        - { column: status, op: eq, value: draft }
        - { column: status, op: eq, value: archived }

  - not:
      column: deleted_at
      op: is_null

  - when: "${{ inputs.excludeInternal }}"
    not:
      sql: "namespace LIKE 'internal%'"
```

### Conditional clauses

Any clause can include `when:` — evaluated at runtime before query construction:

```yaml
where:
  - when: "${{ inputs.q != '' }}"
    or:
      - { column: name, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
      - { column: namespace, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
      - { column: description, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
```

---

## `groupBy` and `having`

```yaml
columns:
  - namespace
  - name
  - { expr: "count(*)", as: version_count }
  - { expr: "max(published_at)", as: latest_at }
from: modules
groupBy: [namespace, name]
having:
  - { column: version_count, op: gte, value: "${{ inputs.minVersions ?? 1 }}" }
```

`having:` accepts the same clause syntax as `where:` — structured conditions, raw fragments, `or:`, `and:`, `not:`, and `when:`.

---

## `orderBy`

```yaml
orderBy:
  - { column: score, direction: desc }
  - { column: name } # direction defaults to asc
```

---

## `distinct` and `distinctOn`

`distinct: true` emits `SELECT DISTINCT`:

```yaml
distinct: true
columns: [namespace, name]
from: modules
```

`distinctOn:` is Postgres-specific and keeps only the first row per group (ordered by `orderBy`):

```yaml
distinctOn: [namespace, name]
columns: [namespace, name, version, published_at]
orderBy:
  - { column: namespace }
  - { column: name }
  - { column: published_at, direction: desc }
```

---

## `limit` and `offset`

Both accept literal integers or CEL expressions. They are always bound as parameters — no injection surface.

```yaml
limit: "${{ inputs.limit ?? 20 }}"
offset: "${{ inputs.offset ?? 0 }}"
```

---

## Full example — module search

```yaml
kind: Sql.Select
metadata:
  name: SearchModules
connection:
  kind: Sql.Connection
  name: Db
from: modules
distinctOn: [namespace, name]
columns: [namespace, name, version, description, published_at]
where:
  - { column: deleted_at, op: is_null }
  - when: "${{ inputs.q != '' }}"
    or:
      - { column: name, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
      - { column: namespace, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
      - { column: description, op: ilike, value: "${{ '%' + inputs.q + '%' }}" }
      - sql: "to_tsvector(description) @@ plainto_tsquery($1)"
        bindings: ["${{ inputs.q }}"]
  - when: "${{ inputs.since != '' }}"
    sql: "published_at > $1::timestamptz"
    bindings: ["${{ inputs.since }}"]
orderBy:
  - { column: namespace }
  - { column: name }
  - { column: published_at, direction: desc }
limit: "${{ inputs.limit ?? 20 }}"
offset: "${{ inputs.offset ?? 0 }}"
inputSchema:
  q: { type: string, default: "" }
  limit: { type: integer, default: 20 }
  offset: { type: integer, default: 0 }
  since: { type: string, default: "" }
```

Calling it from an HTTP route:

```yaml
- request:
    path: /search
    method: GET
  handler:
    kind: Sql.Select
    name: SearchModules
  inputs:
    q: "${{ request.query.q ?? '' }}"
    limit: "${{ int(request.query.limit ?? '20') }}"
    offset: "${{ int(request.query.offset ?? '0') }}"
  response:
    - status: 200
      body:
        results: "${{ result.rows }}"
        count: "${{ result.rowCount }}"
```

---

## Result shape

Same as `Sql.Query`:

```ts
{
  rows: (Record < string, unknown > []);
  rowCount: number;
}
```

---

## Connection and transaction

`Sql.Select` accepts the same `connection` and `transaction` references as `Sql.Query`. If both are present, `transaction` takes precedence. Transactions propagated via `AsyncLocalStorage` (from a wrapping `Sql.Transaction`) are also picked up automatically.
