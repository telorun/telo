---
description: "The current strategy for layered graphs on PostgreSQL: the table, node, relationship and store kinds, and exactly what they create in the database."
sidebar_label: Graph layers — current (PostgreSQL)
---

# `GraphLayersCurrentPostgres`

> Examples assume this module is imported under alias `Layers` and `postgres` under `Postgres`.

## Declaring storage

**Every table is a resource you declare** and list in the `Postgres.Schema`, which creates and migrates it at start-up. Nothing is registered at init, and this module issues no DDL.

- **`Layers.NodeTable`** — a `Postgres.Table` for one node type. You write `table` (the physical name), `key` (the identifying column) and `columns`, in PostgreSQL's own column vocabulary — the same entries `Postgres.Table` takes, a `!ref` to a `Postgres.Enum` included. Optional: `indexes`, `checks`, `renamedFrom`.
- **`Layers.RelationshipTable`** — the same, with `sourceColumn` and `targetColumn` in place of `key`.

The table kinds offer no `seeds`, `foreignKeys` or `internalColumns`: writing one is a `SCHEMA_VIOLATION`. So is a column or an index whose name begins `graph_` — that prefix is the table's own, for what it adds (below); an index may still *name* the columns `graph_layer` and `graph_effect`. Declare the key and the endpoint columns `nullable: false`, and nothing `primaryKey`, `unique` or `identity` — the [rules](../../graph-layers-sql/docs/layered-sql.md#rules) say why.

**A table kind is held to `Postgres.Table`'s own rules**, restated on its fields under the engine's codes — an index over an undeclared column, a `key` or endpoint column that names none (`SQL_INDEX_UNKNOWN_COLUMN`), the rename rules, a second `primaryKey`, an enum the schema does not list — so `telo check` reports them on the table itself, whether or not a node type references it. One of them is stricter than boot: a relationship table naming one column for both endpoints is reported at check on the table, while at creation it is refused only once a relationship type references the table, as `GRAPH_ENDPOINT_UNKNOWN_COLUMN` on that type. The column, index and check entries are `Postgres.Table`'s, restated here because a table kind carries its own row projection; this module's unit test (`nodejs/tests/engine-vocabulary.test.ts`) fails when an entry, the projection or the rule list falls out of step with the engine's.

- **`Layers.Node`** — `table` (a `NodeTable`) and `key`, the table's own key.
- **`Layers.Relationship`** — `table` (a `RelationshipTable`), `source` / `target` node types, and `sourceColumn` / `targetColumn`, the table's own.
- **`Layers.Store`** — `connection`, `schema`, `layer` (its name), optional `bases` (other stores, highest precedence first; two bases may share a base), `nodes`, optional `relationships`.

A plain `Postgres.Table` at a node's `table` is a `REFERENCE_KIND_MISMATCH`: the slot takes this module's table kind, which is what guarantees the layer bookkeeping exists.

**A key or endpoint column must be a type PostgreSQL's driver returns as the table declares it.** `date`, `timestamp`, `timestamptz`, `interval`, `bigint` and `numeric` columns are not, today — the driver returns host dates for the first four and text for the last two — so they cannot be node keys or relationship endpoints: an operation returning such a key is refused by its own contract (`ERR_OUTPUT_INVALID`). Use `text`, `uuid`, `integer`, `boolean`, `bytea` or `doublePrecision`; see [the shared rules](../../graph-layers-sql/docs/layered-sql.md#how-layers-are-stored).

## What exists in the database

Your declaration shows only your columns. After the schema has run, each table holds them plus what the table kind adds:

| Object | On | Definition |
| --- | --- | --- |
| column `graph_layer` | every layered table | `text`, not null — the name of the layer the row belongs to |
| column `graph_effect` | every layered table | `text`, not null — `stated` or `removed` |
| index `graph_<table>_layer_key` | node table | unique on (`graph_layer`, key) |
| index `graph_<table>_layer_pair` | relationship table | unique on (`graph_layer`, source column, target column) |
| index `graph_<table>_layer_target` | relationship table | on (`graph_layer`, target column, source column) |

`<table>` is the physical table name. There is no other object: no bookkeeping table, no foreign key, no trigger. A layer exists as soon as a store names it, and holds nothing until something is written.

The added columns are the table's *internal* columns: the schema creates, compares and reclaims them like any other, and they appear in no operation's `key`, `properties` or `where`. A layered table is an ordinary declared table to the schema — removing one from the manifest lists it under the schema's `status.pendingReclamation` and it is held under the schema's `reclaim:` policy.

Rows written by hand must fill both columns; a row with any other `graph_effect` is never read as a value.

## Behaviour

How a layer reads and writes is [`graph-layers`](../../graph-layers/docs/graph-layers.md); the statements, the indexes they rest on and what a page costs are [`graph-layers-sql`](../../graph-layers-sql/docs/layered-sql.md). This strategy keeps no history and pins nothing: each layer holds only its current statements, and a write is visible as soon as it commits.
