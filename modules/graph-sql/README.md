# Graph SQL

A [`graph`](../graph/README.md) backend over ordinary SQL tables, on SQLite and PostgreSQL alike. Every node type and every relationship type is its own table, written as a plain `SQLite.Table` / `Postgres.Table` and listed in the engine `Schema`, which creates and migrates it. `GraphSql` maps the graph onto those tables, performs every write and query, and never issues DDL.

## Why use this

- **Tables stay yours** — a node table is any table; a relationship table is one with two cascading foreign keys and a unique index. Migrate them, seed them and query them with every other SQL tool as usual.
- **The database does the integrity** — deleting a node removes its relationships through the tables' `onDelete: cascade` keys, and at most one relationship per ordered pair is the unique index, so nothing is enforced twice or in the wrong place.
- **One statement per operation** — `INSERT … ON CONFLICT … RETURNING`, `UPDATE` / `DELETE … RETURNING`, and a traversal as one `WITH RECURSIVE` query, in the SQL both engines speak. Identifiers come from declarations and are quoted by the connection's dialect; every value is bound.
- **Joins your transactions** — inside a `Sql.Transaction` on the store's connection, every write is part of it.
- **Pages by seeking** — a listing resumes at its cursor through the key's index, so a page costs its `limit`, not its position; [which indexes that needs](docs/sql-graph.md#indexes-the-paging-promises-rest-on) is two lines on a relationship table.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphSql.Node` | Provider (extends `Graph.Node`) | A node type over `table:`, identified by the `key:` column. |
| `GraphSql.Relationship` | Provider (extends `Graph.Relationship`) | A relationship type over `table:`, whose `sourceColumn` / `targetColumn` reference the `source` / `target` node types' tables. |
| `GraphSql.Store` | Provider (extends `Graph.Store`) | The graph over `connection:`, with the `schema:` that declares every table it uses and addresses each in its namespace. |

## Example

```yaml
imports:
  Sql: ../sql
  SQLite: ../sqlite
  Graph: ../graph
  GraphSql: ../graph-sql
---
kind: SQLite.Connection
metadata: { name: db }
file: ":memory:"
---
kind: SQLite.Table
metadata: { name: people }
table: people
columns:
  id: { type: text, primaryKey: true }
  name: { type: text }
---
kind: SQLite.Table
metadata: { name: knowsTable }
table: knows
columns:
  source: { type: text, nullable: false }
  target: { type: text, nullable: false }
  since: { type: integer }
indexes:
  knowsPair: { columns: [source, target], unique: true }
  knowsByTarget: { columns: [target, source] }
foreignKeys:
  knowsSource: { columns: [source], references: { table: !ref people, columns: [id] }, onDelete: cascade }
  knowsTarget: { columns: [target], references: { table: !ref people, columns: [id] }, onDelete: cascade }
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref people, !ref knowsTable]
---
kind: GraphSql.Node
metadata: { name: person }
table: !ref people
key: id
---
kind: GraphSql.Relationship
metadata: { name: knows }
table: !ref knowsTable
source: !ref person
target: !ref person
sourceColumn: source
targetColumn: target
---
kind: GraphSql.Store
metadata: { name: kb }
connection: !ref db
schema: !ref appSchema
nodes: [!ref person]
relationships: [!ref knows]
```

List the `Schema` in the application's `targets:` before anything that reads the graph. The operations are `graph`'s — `Graph.CreateNode`, `Graph.Traverse`, … with `store: !ref kb`.

## Docs

- [Tables, rules and the SQL the store runs](docs/sql-graph.md)
