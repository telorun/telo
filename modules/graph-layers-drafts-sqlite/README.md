# Graph Layers — drafts, SQLite

Layered knowledge graphs in SQLite **edited in drafts**: several graphs kept as named layers over one set of tables, each layer's changes staged in a draft and published atomically as a numbered revision. This is the *drafts* strategy of [`graph-layers`](../graph-layers/README.md) for SQLite — declare your storage with these kinds, then use the `Graph` operations and the `GraphLayers` drafting operations over a store.

## Why use this

- **Stage, then publish** — open a draft, write inside a `GraphLayers.DraftSession`, and publish everything at once or discard it. Nothing staged is visible outside the draft's sessions.
- **Conflicts are listed, not lost** — a draft the layer has moved under is refused, rebased, and what collides is listed in five classes to decide by side, by a side with values set on top, or by any invocable.
- **One row of each kind per key** — a layer keeps one published row and at most one draft row per key, so a draft costs only what it changes. Only the current revision is kept.
- **Declared storage** — every table, the two bookkeeping tables included, is a resource you declare and list in the `SQLite.Schema`. The module issues no DDL.
- **Still a layered graph** — a store reads its own statements over its bases', writes only to itself, and every `Graph` operation works unchanged.

What it does not do: keep earlier revisions, open two drafts on one layer, or merge two sides' changes to different properties of one key by itself. Those are the revisioned level of [`graph-layers`](../graph-layers/README.md#the-three-levels).

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphLayersDraftsSqlite.NodeTable` | Provider | A `SQLite.Table` for one node type: `table`, `key`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersDraftsSqlite.RelationshipTable` | Provider | A `SQLite.Table` for one relationship type: `table`, `sourceColumn`, `targetColumn`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersDraftsSqlite.LayersTable` | Provider | The register of layers and their revision counters: `table`. |
| `GraphLayersDraftsSqlite.DraftsTable` | Provider | The record of every draft: `table`. |
| `GraphLayersDraftsSqlite.Node` | Provider | A node type: `table` (a `NodeTable`), `key`. |
| `GraphLayersDraftsSqlite.Relationship` | Provider | A relationship type: `table` (a `RelationshipTable`), `source`, `target`, `sourceColumn`, `targetColumn`. |
| `GraphLayersDraftsSqlite.Store` | Provider | One drafted layer: `connection`, `schema`, `layer`, optional `bases`, `nodes`, optional `relationships`, `layers`, `drafts`. |

## Example

```yaml
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
  Layers: oci://ghcr.io/telorun/graph-layers-drafts-sqlite@<version>
  Graph: oci://ghcr.io/telorun/graph@<version>
  GraphLayers: oci://ghcr.io/telorun/graph-layers@<version>
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
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
kind: Layers.LayersTable
metadata: { name: graphLayers }
table: graph_layers
---
kind: Layers.DraftsTable
metadata: { name: graphDrafts }
table: graph_drafts
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref people, !ref knowsTable, !ref graphLayers, !ref graphDrafts]
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
layers: !ref graphLayers
drafts: !ref graphDrafts
---
kind: Layers.Store
metadata: { name: team }
connection: !ref db
schema: !ref appSchema
layer: team
bases: [!ref shared]
nodes: [!ref person]
relationships: [!ref knows]
layers: !ref graphLayers
drafts: !ref graphDrafts
---
kind: Graph.MergeNode
metadata: { name: savePerson }
store: !ref team
node: !ref person
```

`savePerson` on a person only `shared` states copies the row into `team` and applies the change there; `shared` is untouched, and the result's `origin` is `team`.

Every store names the two bookkeeping tables, and the schema lists them. Then stage and publish:

```yaml
kind: Run.Sequence
metadata: { name: addPerson }
steps:
  - name: open
    invoke: { kind: GraphLayers.OpenDraft, store: !ref team }
    inputs: {}
  - name: stage
    inputs: { draft: !cel "steps.open.result.draft.id" }
    invoke:
      kind: GraphLayers.DraftSession
      store: !ref team
      inputs: { draft: !cel "inputs.draft" }
      steps:
        - name: add
          invoke: { kind: Graph.CreateNode, store: !ref team, node: !ref person }
          inputs: { key: ada, properties: { name: Ada } }
  - name: publish
    invoke: { kind: GraphLayers.Publish, store: !ref team }
    inputs: { draft: !cel "steps.open.result.draft.id" }
```

## Docs

- [Declaring storage, and exactly what exists in the database](docs/drafts-sqlite.md)
- [Drafting — sessions, publish, rebase, conflicts](../graph-layers/docs/drafting.md)
- [Drafted tables in SQL — rows, revisions and what each operation writes](../graph-layers-sql/docs/drafted-sql.md)
