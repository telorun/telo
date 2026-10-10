---
description: "The drafts strategy for layered graphs on SQLite: the table, bookkeeping, node, relationship and store kinds, and exactly what they create in the database."
sidebar_label: Graph layers — drafts (SQLite)
---

# `GraphLayersDraftsSqlite`

> Examples assume this module is imported under alias `Layers` and `sqlite` under `SQLite`.

## Declaring storage

**Every table is a resource you declare** and list in the `SQLite.Schema`, which creates and migrates it at start-up. Nothing is registered at init, and this module issues no DDL.

- **`Layers.NodeTable`** — a `SQLite.Table` for one node type. You write `table`, `key` and `columns`, in SQLite's own column vocabulary — the same entries `SQLite.Table` takes, a `!ref` to a `SQLite.Enum` included. Optional: `indexes`, `checks`, `renamedFrom`.
- **`Layers.RelationshipTable`** — the same, with `sourceColumn` and `targetColumn` in place of `key`.
- **`Layers.LayersTable`**, **`Layers.DraftsTable`** — the two bookkeeping tables. You write one field, `table`, the physical name; every column is the store's. Neither declares a row projection, so nothing can be typed from one: a repository over a bookkeeping table is refused by `telo check` before it can name a column.

The typed table kinds offer no `seeds`, `foreignKeys` or `internalColumns`: writing one is a `SCHEMA_VIOLATION`. So is a column or an index whose name begins `graph_` — that prefix is the table's own; an index may still *name* the bookkeeping columns. Declare the key and the endpoint columns `nullable: false`, and nothing `primaryKey`, `unique` or `identity` — the [rules](../../graph-layers-sql/docs/layered-sql.md#rules) say why.

**A typed table kind is held to `SQLite.Table`'s own rules**, restated on its fields under the engine's codes — an index over an undeclared column, a `key` or endpoint column that names none (`SQL_INDEX_UNKNOWN_COLUMN`), the rename rules, a second `primaryKey`, an enum the schema does not list — so `telo check` reports them on the table itself. One is stricter than boot: a relationship table naming one column for both endpoints is reported at check on the table, while at creation it is refused only once a relationship type references the table, as `GRAPH_ENDPOINT_UNKNOWN_COLUMN` on that type. The column, index and check entries are `SQLite.Table`'s, restated here because a table kind carries its own row projection; this module's unit test (`nodejs/tests/engine-vocabulary.test.ts`) fails when an entry, the projection or the rule list falls out of step with the engine's.

- **`Layers.Node`** — `table` (a `NodeTable`) and `key`, the table's own key.
- **`Layers.Relationship`** — `table` (a `RelationshipTable`), `source` / `target` node types, and `sourceColumn` / `targetColumn`, the table's own.
- **`Layers.Store`** — `connection`, `schema`, `layer`, optional `bases` (other drafted stores, highest precedence first), `nodes`, optional `relationships`, and `layers` / `drafts` — the two bookkeeping tables, which a layer and its bases share.

The slots name this module's own kinds: a plain `SQLite.Table`, or a table or node type of the current strategy's module, is a `REFERENCE_KIND_MISMATCH` — the static guarantee that the bookkeeping a draft needs exists. The store's own rules are [`graph-layers-sql`](../../graph-layers-sql/docs/drafted-sql.md#rules-of-the-drafted-store).

## What exists in the database

Your declarations show only your columns and two table names. After the schema has run:

| Where | Holds |
| --- | --- |
| each typed table, columns | `graph_layer` (the layer's internal id), `graph_state` (`draft` or `published`), `graph_effect` (`stated`, `removed`; `retracted` on a draft row), `graph_revision` (the revision that published the row; null on a draft row), `graph_over` (on a draft row, the revision of the published row it was written over or last rebased onto), `graph_written_at`, `graph_resolution` (`mine`, `theirs`, `merged`; null), `graph_resolved_by_type`, `graph_resolved_by_id` |
| each typed table, indexes | `graph_<table>_layer_key` — unique on (`graph_layer`, `graph_state`, key); on a relationship table `graph_<table>_layer_pair` — unique on (`graph_layer`, `graph_state`, source, target) — and `graph_<table>_layer_target` on (`graph_layer`, `graph_state`, target, source) |
| the layers table | `id` (UUIDv7, primary key), `name` (unique), `head_revision`, `created_at`, `created_by_type`, `created_by_id` |
| the drafts table | `id` (UUIDv7, primary key), `public_id` (unique), `layer_id`, `parent_revision`, `message`, `created_at` / `created_by_type` / `created_by_id`, `published_at` / `published_by_type` / `published_by_id`, `discarded_at` / `discarded_by_type` / `discarded_by_id`, `revision`, `open_slot`; and `graph_<table>_open`, a unique index on (`layer_id`, `open_slot`) restricted to rows neither published nor discarded |

`<table>` is the physical table name. On SQLite, ids are `text`, revisions `integer`, instants fixed-width UTC `text` (`YYYY-MM-DDTHH:MM:SS.sssZ`); the store writes every instant as `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`. There is no other object: no foreign key, no trigger.

- **No state column on a draft.** A draft is open while `published_at` and `discarded_at` are both null.
- **One draft per layer**, enforced by the database through the partial unique index. `open_slot` is **temporary**: a constant the store never names, there only because the schema pass reads a one-column unique index back as a `unique` flag on the column and then refuses the table on its second boot. Every row holds `1`, so the index is unique per layer all the same. Once the schema pass tells an index from a column flag, the index narrows to `layer_id` and the column is dropped by the schema pass itself, with no change to the store.
- **At most one draft row and one published row per key and layer**, through the unique index on layer, state and key.
- **State leads the key in every index**, so a layer's draft rows are one contiguous range and its published rows another. A reader of published rows never passes a draft row, and publishing, discarding, rebasing and listing conflicts read the draft, not the layer.

The added columns of a typed table are its *internal* columns: the schema creates, compares and reclaims them like any other, and they appear in no operation's `key`, `properties` or `where`. Rows written by hand must fill `graph_layer`, `graph_state`, `graph_effect` and `graph_written_at`, and a published row its `graph_revision`.

## Behaviour

How a draft is opened, edited in a session, published, rebased and its conflicts decided is [`graph-layers`](../../graph-layers/docs/drafting.md); what each operation writes is [`graph-layers-sql`](../../graph-layers-sql/docs/drafted-sql.md). On this strategy:

- **A layer has one open draft.** `OpenDraft` returns the open one with `opened: false`; two processes opening at once get the same draft. A draft is opened under the layer's row, as it is published, so an open racing a publish is always answered — with the draft still open, or with a new one.
- **Only the current revision is kept.** A revision number identifies the layer's state now; earlier states are gone once published over.
- **Conflicts are compared row against row.** Nothing is kept of the ancestor, so two sides changing different properties of one key collide as one `changed-both`, and a conflict has no `base`.
- **A conflict page costs the draft, not `limit`.** Conflicts are not stored: a page compares the draft with the layer as it stands, reading the draft's rows and the relationships at the nodes it removes or retracts. It never reads the layer.
- **Published writes to one layer are applied one at a time**: each takes the layer's row to advance its revision. A write that changes nothing the layer states advances nothing, so it never turns an open draft stale. A bulk load belongs in a draft.
- **Who and when.** The actor and the database's own time are recorded when a draft is opened, published and discarded; omitted, the actor is the store itself, `{ type: store, id: <the store's declared name> }`, whatever alias the application imports this module under.
