# Graph Layers — current, PostgreSQL

Layered knowledge graphs in PostgreSQL with **no versioning**: several graphs kept as named layers over one set of tables, each layer holding only its current statements. This is the *current* strategy of [`graph-layers`](../graph-layers/README.md) for PostgreSQL — declare your storage with these kinds, then use the `Graph` operations and `GraphLayers.RetractNode` / `RetractRelationship` over a store.

## Why use this

- **Layers build on layers** — a store names its `layer` and the `bases` it is built on; it reads its own statements over theirs and writes only to itself.
- **Declared storage** — every table is a resource you declare and list in the `Postgres.Schema`, which creates and migrates it. The module issues no DDL and keeps no bookkeeping table.
- **Typed from your columns** — an operation's `key` and `properties` are typed from the columns you declare; the layer bookkeeping columns are in no contract.
- **Checked before boot** — a table that cannot hold layers (a unique column, a nullable key, a `graph_…` name), or that the engine itself would refuse (an index over an undeclared column, a rename from a column still declared), is reported by `telo check`.

What it cannot do — history, drafts, a pinned view of a base — is listed in [`graph-layers`](../graph-layers/README.md#what-the-current-strategy-cannot-do).

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphLayersCurrentPostgres.NodeTable` | Provider | A `Postgres.Table` for one node type: `table`, `key`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersCurrentPostgres.RelationshipTable` | Provider | A `Postgres.Table` for one relationship type: `table`, `sourceColumn`, `targetColumn`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersCurrentPostgres.Node` | Provider | A node type: `table` (a `NodeTable`), `key`. |
| `GraphLayersCurrentPostgres.Relationship` | Provider | A relationship type: `table` (a `RelationshipTable`), `source`, `target`, `sourceColumn`, `targetColumn`. |
| `GraphLayersCurrentPostgres.Store` | Provider | One layer: `connection`, `schema`, `layer`, optional `bases`, `nodes`, optional `relationships`. |

## Example

```yaml
imports:
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  Layers: oci://ghcr.io/telorun/graph-layers-current-postgres@<version>
  Graph: oci://ghcr.io/telorun/graph@<version>
---
kind: Postgres.Connection
metadata: { name: db }
connectionString: !cel "secrets.databaseUrl"
---
kind: Layers.NodeTable
metadata: { name: people }
table: people
key: id
columns:
  id: { type: text, nullable: false }
  name: { type: text, nullable: false }
---
kind: Layers.RelationshipTable
metadata: { name: knowsTable }
table: knows
sourceColumn: source
targetColumn: target
columns:
  source: { type: text, nullable: false }
  target: { type: text, nullable: false }
  since: { type: integer }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
schema: knowledge
tables: [!ref people, !ref knowsTable]
---
kind: Layers.Node
metadata: { name: person }
table: !ref people
key: id
---
kind: Layers.Relationship
metadata: { name: knows }
table: !ref knowsTable
source: !ref person
target: !ref person
sourceColumn: source
targetColumn: target
---
kind: Layers.Store
metadata: { name: shared }
connection: !ref db
schema: !ref appSchema
layer: shared
nodes: [!ref person]
relationships: [!ref knows]
---
kind: Layers.Store
metadata: { name: team }
connection: !ref db
schema: !ref appSchema
layer: team
bases: [!ref shared]
nodes: [!ref person]
relationships: [!ref knows]
---
kind: Graph.MergeNode
metadata: { name: savePerson }
store: !ref team
node: !ref person
```

`savePerson` on a person only `shared` states copies the row into `team` and applies the change there; `shared` is untouched, and the result's `origin` is `team`.

## Docs

- [Declaring layered storage in PostgreSQL, and what exists in the database](docs/current-postgres.md)
- [Layers, precedence, writes, hiding and retraction](../graph-layers/docs/graph-layers.md)
- [The rules a layered table must satisfy, and what a page costs](../graph-layers-sql/docs/layered-sql.md)
