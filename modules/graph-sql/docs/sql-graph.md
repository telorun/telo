---
description: "GraphSql: a knowledge graph over declared SQL tables — what the node and relationship tables must declare, the rules telo check enforces, and the SQL each operation runs on SQLite and PostgreSQL."
sidebar_label: GraphSql
---

# `GraphSql`

> Examples assume this module is imported under alias `GraphSql`, and `graph` under `Graph`.

## Tables are plain

Every node type and relationship type is its own table, declared as an ordinary engine table (`SQLite.Table`, `Postgres.Table`) and listed in the engine `Schema`. The schema creates and migrates the tables exactly as it would any other — renames, tombstones, reclamation, seeds all apply — and `GraphSql` never issues DDL. What the graph adds is a mapping and a set of rules the tables must satisfy.

**A node table** holds one node per row. Its `key:` column identifies the node: the primary key, or `unique` and `nullable: false`, and never an `identity` column — a node's key is supplied by whoever writes it. A key column projects non-nullable, so a `null` key is refused (by `telo check` as written, with `ERR_INPUT_INVALID` when computed) and nothing is ever generated for it: an SQLite `INTEGER PRIMARY KEY` is a valid node key, and SQLite never picks its rowid because a key is always given. Every other column is a property of the node, and the node's contract is typed from the table's row projection.

**A relationship table** holds one relationship per row:

- `sourceColumn` and `targetColumn` hold the endpoint nodes' keys. Each is a foreign key over exactly that column to the endpoint node's table and key column, with `onDelete: cascade` — the database deletes a node's relationships through it.
- A unique index over exactly the two endpoint columns, with no `where:` — at most one relationship of a type joins an ordered pair.
- Every other column is a property of the relationship.

On SQLite, declared foreign keys are enforced on every host, so the cascade runs under Node and Bun alike.

**The store** names the `connection:` its statements run on and the `schema:` that declares its tables. The schema must live on the same connection and list every node and relationship table, and no two types may share a table.

## Rules

Each is reported by `telo check` as `RESOURCE_RULE_VIOLATED` with the code in `data.rule`, and refused again, under the same code, when the resource is created.

| Code | Kind | Refuses |
| --- | --- | --- |
| `GRAPH_NODE_KEY_UNKNOWN_COLUMN` | `GraphSql.Node` | `key` names a column the table does not declare |
| `GRAPH_NODE_KEY_INVALID` | `GraphSql.Node` | the key column is not the primary key, and not `unique` with `nullable: false`, or it is an `identity` column |
| `GRAPH_ENDPOINT_UNKNOWN_COLUMN` | `GraphSql.Relationship` | `sourceColumn` / `targetColumn` undeclared, or the same column |
| `GRAPH_ENDPOINT_FOREIGN_KEY_MISSING` | `GraphSql.Relationship` | no foreign key over exactly the endpoint column to the endpoint node's table and key, with `onDelete: cascade` |
| `GRAPH_RELATIONSHIP_NOT_UNIQUE` | `GraphSql.Relationship` | no unique index over exactly the two endpoint columns |
| `GRAPH_TABLE_NOT_IN_SCHEMA` | `GraphSql.Store` | a listed type's table is not in `schema.tables` |
| `GRAPH_SCHEMA_CONNECTION_MISMATCH` | `GraphSql.Store` | `schema.connection` is not the store's `connection` |
| `GRAPH_TABLE_SHARED` | `GraphSql.Store` | two listed types over one table |

`graph`'s own rules (a type the store does not list, hops that do not chain, …) apply as well.

The two schema rules read the schema's declaration, so they do not run statically while that declaration holds a `!cel` among its top-level fields — the conventional `version: !cel "module.version"` is one — and `telo check` reports the skip (`RESOURCE_RULE_SKIPPED`). The creation-time refusal still applies.

## What each operation runs

Every statement is built when the store (or, for a traversal, the operation) is created, from the declarations: each table named as the store's `schema:` addresses it (see [Namespaces](#namespaces)), column names quoted by the connection's dialect, and nothing from a call's input written as text — an input property name only selects a declared column. A call binds values, and the `where` conditions it asks for.

| Operation | Statement |
| --- | --- |
| `CreateNode` | `INSERT … ON CONFLICT (key) DO NOTHING RETURNING …` — no row returned is `GRAPH_NODE_EXISTS` |
| `MergeNode` | `INSERT … ON CONFLICT (key) DO UPDATE SET <given> RETURNING …` |
| `UpdateNode` / `DeleteNode` | `UPDATE` / `DELETE … WHERE key = ? RETURNING …` — no row is `GRAPH_NODE_NOT_FOUND` |
| `GetNode` / `FindNodes` | `SELECT … ORDER BY key LIMIT ? OFFSET ?` |
| `CreateRelationship` | `INSERT … SELECT` from the two node tables `ON CONFLICT (source, target) DO NOTHING RETURNING …` — an absent endpoint selects no row, and a conflict inserts none; when nothing is returned, one read of the two node tables decides between `GRAPH_NODE_NOT_FOUND` (naming the endpoint) and `GRAPH_RELATIONSHIP_EXISTS` |
| `MergeRelationship` | the same `INSERT … SELECT … DO UPDATE SET <given>` — no row is `GRAPH_NODE_NOT_FOUND` |
| `UpdateRelationship` / `DeleteRelationship` | `UPDATE` / `DELETE … WHERE source = ? AND target = ? RETURNING …` |
| `FindRelationships` | `SELECT … ORDER BY source, target LIMIT ? OFFSET ?` |
| `DeleteNode`'s relationships | the database's cascade — no statement of the store's |
| `Traverse` | one `WITH RECURSIVE` query: the start node, then one key set per hop — a hop taken once is a join, a repeated hop a recursive CTE over (key, depth) bounded by `maxHops`, whose `UNION` de-duplicates on that pair so a cycle ends at the bound; the end nodes' `where`, order and paging run inside it |

A merge proposes a full row, and the engine checks it before it resolves the conflict, so for each column the merge is not given that is `nullable: false` with no default, the stored value is carried into the proposed row. On a new node that value is missing and the engine refuses the insert — a required property was not given.

No operation opens a transaction; each statement runs on the ambient `Sql.Transaction` of the store's connection when there is one. An outcome is always read from the rows a statement returns — never by interpreting a driver error — and a driver error (a constraint the graph model does not describe, a lost connection) reaches the caller unchanged.

A driver returning an `int8` / `bigint` column as text (PostgreSQL's) returns a key or property of that type as text; declare `integer` columns where the contract's integers must round-trip.

## Namespaces

Every table is addressed in the namespace of the store's `schema:`, never by a bare name. The schema resource owns where its tables live, so it renders each table reference: `Postgres.Schema` qualifies it with its `schema:` namespace (`public` when omitted), and `SQLite.Schema`, whose database has one namespace, names the table on its own. What the connection's `search_path` holds, or which role it runs as, does not change which tables a statement reaches.

Schema-per-tenant is one `Postgres.Schema` per tenant namespace, each listing the same tables, and one store per tenant schema. The node and relationship types can be shared between the stores — they describe the tables, not where they are — and a node written through one tenant's store is absent through another's.

A store whose `schema:` is an engine kind from a module that predates table addressing fails when it is created, naming the store, the schema resource and its kind; upgrade that engine module.
