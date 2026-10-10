---
description: "The revisions strategy for layered graphs on SQLite: the table, bookkeeping, node, relationship and store kinds, exactly what they create in the database — the pinned base lists and revision labels included — the index set, what a pin move costs and the throughput property."
sidebar_label: Graph layers — revisions (SQLite)
---

# `GraphLayersRevisionsSqlite`

> Examples assume this module is imported under alias `Layers` and `sqlite` under `SQLite`.

## Declaring storage

**Every table is a resource you declare** and list in the `SQLite.Schema`, which creates and migrates it at start-up. Nothing is registered at init, and this module issues no DDL.

- **`Layers.NodeTable`** — a `SQLite.Table` for one node type. You write `table`, `key` and `columns`, in SQLite's own column vocabulary — the same entries `SQLite.Table` takes, a `!ref` to a `SQLite.Enum` included. Optional: `indexes`, `checks`, `renamedFrom`.
- **`Layers.RelationshipTable`** — the same, with `sourceColumn` and `targetColumn` in place of `key`.
- **`Layers.LayersTable`**, **`Layers.ChangesetsTable`**, **`Layers.ChangesetBasesTable`** — the three bookkeeping tables. You write one field, `table`, the physical name; every column is the store's. None declares a row projection, so nothing can be typed from one: a repository over a bookkeeping table is refused by `telo check` before it can name a column.

The typed table kinds offer no `seeds`, `foreignKeys` or `internalColumns`: writing one is a `SCHEMA_VIOLATION`. So is a column or an index whose name begins `graph_` — that prefix is the table's own; an index may still *name* the bookkeeping columns. Declare the key and the endpoint columns `nullable: false`, and nothing `primaryKey`, `unique` or `identity` — the [rules](../../graph-layers-sql/docs/layered-sql.md#rules) say why.

**A typed table kind is held to `SQLite.Table`'s own rules**, restated on its fields under the engine's codes — an index over an undeclared column, a `key` or endpoint column that names none (`SQL_INDEX_UNKNOWN_COLUMN`), the rename rules, an enum the schema does not list — so `telo check` reports them on the table itself. One is tighter than the engine's own: **no column may be `primaryKey`** (`SQL_COMPOSITE_PRIMARY_KEY`), since the table's own row id is its primary key and one more would make it composite. One is stricter than boot: a relationship table naming one column for both endpoints is reported at check on the table, while at creation it is refused only once a relationship type references the table, as `GRAPH_ENDPOINT_UNKNOWN_COLUMN` on that type. The column, index and check entries are `SQLite.Table`'s, restated here because a table kind carries its own row projection; this module's unit test (`nodejs/tests/engine-vocabulary.test.ts`) fails when an entry, the projection or the rule list falls out of step with the engine's.

- **`Layers.Node`** — `table` (a `NodeTable`) and `key`, the table's own key.
- **`Layers.Relationship`** — `table` (a `RelationshipTable`), `source` / `target` node types, and `sourceColumn` / `targetColumn`, the table's own.
- **`Layers.Store`** — `connection`, `schema`, `layer`, `nodes`, optional `relationships`, and `layers` / `changesets` / `changesetBases`, the three bookkeeping tables, all required. There is no `bases` (writing one is a `SCHEMA_VIOLATION`): what a revisioned layer is built on is pinned at run time with `GraphLayers.PinBase` and kept in the `changesetBases` table. Every layer of a stack is a store over the same three bookkeeping tables and the same typed tables.

The slots name this module's own kinds: a plain `SQLite.Table`, or a table or node type of another strategy's module, is a `REFERENCE_KIND_MISMATCH` — the static guarantee that the bookkeeping a revision needs exists. The store's own rules are [`graph-layers-sql`](../../graph-layers-sql/docs/revisioned-sql.md#rules-of-the-revisioned-store).

## What exists in the database

Your declarations show only your columns and three table names. After the schema has run, every row of a typed table is **one version of one layer's statement about one key, written by one changeset**:

| Column (internal, every typed table) | Meaning |
| --- | --- |
| `graph_row` | primary key, a UUIDv7 of this row version; it never leaves the store |
| `graph_layer` | internal id of the layer that states it, not null |
| `graph_changeset` | the changeset that wrote it, not null |
| `graph_from_revision` | the revision it became current at; null while its changeset is a draft |
| `graph_to_revision` | the revision it stopped being current at; null while current |
| `graph_effect` | `stated`; `removed` — the layer hides a key a layer beneath it states, the row carrying the values it hides; `retracted` on a draft row that withdraws the layer's own statement. Not null |
| `graph_over` | on a draft row, the `graph_row` of the layer's own row the draft was written over or last rebased onto; null when none |
| `graph_beneath` | the `graph_row` of the statement that won among the layers beneath when this row was written or last brought onto a moved pin; null when nothing beneath stated the key |
| `graph_resolution`, `graph_resolved_by_type`, `graph_resolved_by_id` | how a conflict on the row was decided (`mine`, `theirs`, `merged`) and by whom; null otherwise |

| Table | Holds |
| --- | --- |
| the layers table | `id` (primary key), `name` (unique), `head_revision`, `created_at`, `created_by_type`, `created_by_id` |
| the changesets table | `id` (primary key), `public_id` (unique, `gdr_…`), `layer_id`, `parent_revision`, `revision` (unique per layer once set), `message`, `created_at` / `created_by_type` / `created_by_id`, `published_at` / `published_by_type` / `published_by_id`, `discarded_at` / `discarded_by_type` / `discarded_by_id`; `label`, `labelled_at` / `labelled_by_type` / `labelled_by_id` — a published revision's label, null when it has none; `bases_changeset` — the changeset whose rows in the bases table are this changeset's base list, null for a layer built on none |
| the changeset bases table | `id` (primary key), `changeset_id`, `position`, `base_layer_id`, `base_revision` — one row per direct pin of one base list. A list is written once per pin change and shared, through `bases_changeset`, by every changeset until the next change |

On SQLite, ids are `text`, revisions `integer`, instants fixed-width UTC `text` (`YYYY-MM-DDTHH:MM:SS.sssZ`); the store writes every instant as `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. There is no other object: no foreign key, no trigger.

### The index set

| Index | Columns | Serves |
| --- | --- | --- |
| primary key | `graph_row` | a row by id — the ancestor and the layer's row a conflict is judged from |
| `graph_<table>_changeset_key` (unique) | (`graph_changeset`, key) | one row per changeset and key; a draft's rows as one contiguous range |
| `graph_<table>_layer_current` (unique, partial) | (`graph_layer`, key) where `graph_from_revision IS NOT NULL AND graph_to_revision IS NULL` | at most one current statement per layer and key, kept by the database |
| `graph_<table>_layer_key` (partial) | (`graph_layer`, key, `graph_from_revision`) where `graph_from_revision IS NOT NULL` | every published read, as of any revision |

On a relationship table the key is the pair, and two ranges are indexed a second time leading on the target:

| Index | Columns |
| --- | --- |
| `graph_<table>_changeset_pair` (unique) | (`graph_changeset`, source, target) |
| `graph_<table>_changeset_target` | (`graph_changeset`, target, source) |
| `graph_<table>_layer_current` (unique, partial) | (`graph_layer`, source, target), current rows |
| `graph_<table>_layer_pair` (partial) | (`graph_layer`, source, target, `graph_from_revision`), published rows |
| `graph_<table>_layer_target` (partial) | (`graph_layer`, target, source, `graph_from_revision`), published rows |

The changesets table has `graph_<table>_layer_revision`, unique on (`layer_id`, `revision`); `graph_<table>_open` on (`layer_id`, `public_id`) restricted to rows neither published nor discarded; and `graph_<table>_layer_label`, unique on (`layer_id`, `label`) where `label IS NOT NULL` — one label names one revision of a layer. The changeset bases table has `graph_<table>_position`, unique on (`changeset_id`, `position`), and `graph_<table>_layer`, unique on (`changeset_id`, `base_layer_id`). `<table>` is the physical table name.

`graph_beneath` is in no index: nothing is looked up by it.

- **The published indexes hold no draft row**, so a reader of published rows never passes one: a draft of any size beside a page costs that page nothing.
- **A draft's rows are one range** of the changeset index, so publishing, discarding, rebasing and listing conflicts read the draft, not the layer.
- **No changeset has a state column.** It is open while `published_at` and `discarded_at` are both null; published, it has a `revision` unless it changed nothing.

The added columns of a typed table are its *internal* columns: the schema creates, compares and reclaims them like any other, and they appear in no operation's `key`, `properties` or `where`.

## Behaviour

How a draft is opened, edited in a session, published, rebased and its conflicts decided is [`graph-layers`](../../graph-layers/docs/drafting.md); what this level adds is [Revisions](../../graph-layers/docs/revisions.md); what each operation reads and writes is [`graph-layers-sql`](../../graph-layers-sql/docs/revisioned-sql.md). On this strategy:

- **Every revision is kept, and history is unbounded.** A row a revision replaces is ended, never removed, and nothing compacts it: a key rewritten a thousand times holds a thousand rows, and a page that crosses such a key reads them.
- **Any number of drafts are open on a layer.** `OpenDraft` always opens another; each is isolated at its parent revision until rebased.
- **Published writes to one layer are applied one at a time**: each takes the layer's row to allocate its revision and holds it until it commits. Concurrent writers get consecutive revisions, with no retry and no refusal. A write that changes nothing the layer states makes no revision and no row. **A bulk load belongs in a draft.**
- **A publish holds the layer for a time proportional to the draft.**
- **A conflict page costs the draft, not `limit`.** Conflicts are not stored: a page compares the draft with the layer as it stands, reading the draft's rows and the relationships at the nodes it withdraws. It never reads the layer.
- **Who and when.** The actor and the database's own time are recorded when a draft is opened, published and discarded; omitted — and for every write made outside a draft — the actor is the store itself, `{ type: store, id: <the store's declared name> }`, whatever alias the application imports this module under.
- **A layer is built on pinned revisions of others.** Each layer of a stack is read through its own range of the published index, at the revision it is pinned at: a node page costs `limit` × the stack's depth whatever a base has published since. A stack holds at most 32 layers.
- **A pin move costs the layer being re-pinned.** `PinBase` and `UnpinBase` read every statement the layer itself makes — its overrides, removals and relationships, not its bases — once, in key order, with one probe per layer of the new stack for each. That is the same over a base of any size and any history, and it is not reduced by how little changed beneath.
- **A large layer moves a pin inside a draft.** Outside a session a pin move is one published revision and holds the layer's row for the whole walk, as every published write does; inside a draft only the publish holds it.
- **Labels are permanent.** `LabelRevision` sets the label columns of the revision's changeset once; the unique index keeps one label to one revision of a layer.
