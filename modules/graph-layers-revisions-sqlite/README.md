# Graph Layers — revisions, SQLite

Versioned knowledge graphs in SQLite: named layers over one set of tables, where **every revision a layer publishes is kept** and a layer is built on revisions of others it pins. Drafts are parallel and each reads a consistent snapshot; publishing is atomic; a draft that fell behind, and a layer taking a newer revision of a base, are merged three ways, property by property. This is the *revisions* strategy of [`graph-layers`](../graph-layers/README.md) for SQLite — declare your storage with these kinds, then use the `Graph` operations and the `GraphLayers` drafting, pinning and history operations over a store.

## Why use this

- **History is kept** — every publish, and every write made outside a draft that changes what the layer states, is a numbered revision; what it replaces stays in the table. A write that changes nothing makes none, so delivering one twice adds nothing to the history. `GraphLayers.ListRevisions` lists them and serves as a change feed.
- **Parallel, isolated drafts** — any number of drafts are open on a layer at once. A session keeps reading the layer as it stood when its draft began, whatever siblings publish, until it is rebased.
- **Three-way merge** — a rebase compares each side with the row the draft was written over: two sides changing different properties of one key merge by themselves, a conflict names only what clashed, and the ancestor is listed beside it.
- **Reads that stay put** — a listing paged across other callers' publishes stays on the revision of its first page.
- **Pinned stacks** — `GraphLayers.PinBase` builds a layer on a revision of each layer beneath, by number, by label or at its newest. What a base publishes afterwards changes nothing above until the pin is moved, and a diamond is upgraded in one call.
- **Upgrades that merge** — moving a pin merges what the base changed into what the layer states over it, lists what collides as conflicts, and publishes like any draft.
- **Permanent labels** — `GraphLayers.LabelRevision` names a revision for good, so a layer can pin `"2026.10"` rather than a number.
- **Declared storage** — every table, the three bookkeeping tables included, is a resource you declare and list in the `SQLite.Schema`. The module issues no DDL.

## Limits

- Every layer of a stack lives in this database, in these tables, and gets there by the application writing it.
- **Retained history is unbounded**: nothing compacts it.
- A stack holds at most 32 layers.
- A pin move costs the size of the layer being re-pinned, whatever changed beneath.
- Each type is one table; published reads come from the same store that is authored in.
- A reader of one layer can list any layer's revisions in the same tables.

## Throughput

- **Published writes to one layer are applied one at a time.** Each write outside a draft takes the layer's row to allocate its revision, and holds it until it commits. Concurrent writers queue and get consecutive revisions; none is refused or retried.
- **A bulk load belongs in a draft**, where writers contend on nothing but their own draft.
- **A publish holds the layer for a time proportional to the draft.**
- **A pin moved outside a draft holds the layer while every statement the layer makes is re-read.** Move the pin of a large layer inside a draft.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphLayersRevisionsSqlite.NodeTable` | Provider | A `SQLite.Table` for one node type: `table`, `key`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersRevisionsSqlite.RelationshipTable` | Provider | A `SQLite.Table` for one relationship type: `table`, `sourceColumn`, `targetColumn`, `columns`, optional `indexes`, `checks`, `renamedFrom`. |
| `GraphLayersRevisionsSqlite.LayersTable` | Provider | The register of layers and their head revisions: `table`. |
| `GraphLayersRevisionsSqlite.ChangesetsTable` | Provider | The record of every changeset — an open draft, or a published revision with its label: `table`. |
| `GraphLayersRevisionsSqlite.ChangesetBasesTable` | Provider | The record of what each layer is built on — the pinned layers and revisions of every base list: `table`. |
| `GraphLayersRevisionsSqlite.Node` | Provider | A node type: `table` (a `NodeTable`), `key`. |
| `GraphLayersRevisionsSqlite.Relationship` | Provider | A relationship type: `table` (a `RelationshipTable`), `source`, `target`, `sourceColumn`, `targetColumn`. |
| `GraphLayersRevisionsSqlite.Store` | Provider | One revisioned layer: `connection`, `schema`, `layer`, `nodes`, optional `relationships`, `layers`, `changesets`, `changesetBases`. |

## Example

```yaml
imports:
  SQLite: oci://ghcr.io/telorun/sqlite@<version>
  Layers: oci://ghcr.io/telorun/graph-layers-revisions-sqlite@<version>
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
kind: Layers.LayersTable
metadata: { name: graphLayers }
table: graph_layers
---
kind: Layers.ChangesetsTable
metadata: { name: graphChangesets }
table: graph_changesets
---
kind: Layers.ChangesetBasesTable
metadata: { name: graphChangesetBases }
table: graph_changeset_bases
---
kind: SQLite.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref people, !ref graphLayers, !ref graphChangesets, !ref graphChangesetBases]
---
kind: Layers.Node
metadata: { name: person }
table: !ref people
key: id
---
kind: Layers.Store
metadata: { name: team }
connection: !ref db
schema: !ref appSchema
layer: team
nodes: [!ref person]
layers: !ref graphLayers
changesets: !ref graphChangesets
changesetBases: !ref graphChangesetBases
---
kind: Layers.Store
metadata: { name: shared }
connection: !ref db
schema: !ref appSchema
layer: shared
nodes: [!ref person]
layers: !ref graphLayers
changesets: !ref graphChangesets
changesetBases: !ref graphChangesetBases
---
kind: GraphLayers.ListRevisions
metadata: { name: teamHistory }
store: !ref team
```

Stage in a draft, publish it as one revision, then read what the layer has published since a known number:

```yaml
kind: Run.Sequence
metadata: { name: addPerson }
steps:
  - name: open
    invoke: { kind: GraphLayers.OpenDraft, store: !ref team }
    inputs: { message: add Ada }
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
  - name: news
    invoke: !ref teamHistory
    inputs: { order: ascending, after: !cel "steps.open.result.draft.parentRevision" }
```

`news` lists the revision the draft became — and any a sibling published in between, in which case `publish` would have been refused `GRAPH_DRAFT_STALE` and the draft rebased first.

Build `team` on `shared`, label a revision of `shared`, and later take it:

```yaml
kind: Run.Sequence
metadata: { name: buildOnShared }
steps:
  - name: pin
    invoke: { kind: GraphLayers.PinBase, store: !ref team }
    inputs: { bases: [{ layer: shared }] }
  - name: release
    invoke: { kind: GraphLayers.LabelRevision, store: !ref shared }
    inputs: { revision: !cel "steps.pin.result.bases[0].revision", label: "2026.10" }
```

`pin` builds `team` on `shared` at its newest revision, as one revision of `team`; from then on `team` reads `shared` as that revision left it. `release` names that revision of `shared` for good — it must be a published one, so `shared` has to have been written at least once. Taking a later one is `PinBase` again — outside a draft when nothing can collide, and otherwise inside a draft session, where the conflicts it leaves are listed, decided and published ([Revisions](../graph-layers/docs/revisions.md#upgrading-is-a-pin-move)).

## Docs

- [Declaring storage, and exactly what exists in the database](docs/revisions-sqlite.md)
- [Revisions — pinned stacks, upgrades, labels, parallel drafts, three-way merge, the change feed](../graph-layers/docs/revisions.md)
- [Drafting — sessions, publish, rebase, conflicts](../graph-layers/docs/drafting.md)
- [Revisioned tables in SQL — the index set, the pin-move pass and what each operation costs](../graph-layers-sql/docs/revisioned-sql.md)
