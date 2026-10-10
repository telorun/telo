---
description: "GraphSql: a knowledge graph over declared SQL tables — what the node and relationship tables must declare, the rules telo check enforces, and the SQL each operation runs on SQLite and PostgreSQL."
sidebar_label: GraphSql
---

# `GraphSql`

> Examples assume this module is imported under alias `GraphSql`, and `graph` under `Graph`.

## Tables are plain

Every node type and relationship type is its own table, declared as an ordinary engine table (`SQLite.Table`, `Postgres.Table`) and listed in the engine `Schema`. The schema creates and migrates the tables exactly as it would any other — renames, tombstones, reclamation, seeds all apply — and `GraphSql` never issues DDL. What the graph adds is a mapping and a set of rules the tables must satisfy.

**A node table** holds one node per row. Its `key:` column identifies the node: the primary key, or `unique` and `nullable: false`, and never an `identity` column — a node's key is supplied by whoever writes it. A key column projects non-nullable, so a `null` key is refused (by `telo check` as written, with `ERR_INPUT_INVALID` when computed) and nothing is ever generated for it: an SQLite `INTEGER PRIMARY KEY` is a valid node key, and SQLite never picks its rowid because a key is always given. Every other column of the table's row contract is a property of the node, and the node's contract is typed from the table's row projection. A column the table declares under `internalColumns` is the table's own: it is no property, no operation reads or writes it, and it cannot be the key or an endpoint column.

A key or endpoint column may be any type whose values the engine returns as its projected type. On PostgreSQL `date`, `timestamp`, `timestamptz` and `interval` columns are not such types today — the driver returns host dates where the table projects text — so they cannot be node keys or endpoints. Nor can `bigint` and `numeric` columns there: the driver returns them as text where the table projects a number. An operation that returns such a key is refused by its own output contract (`ERR_OUTPUT_INVALID`), and a listing that has a further page past a host date by the cursor's encoding (`ERR_TYPED_FRAME_UNENCODABLE`) — each a coded error, never a node whose key would not address it. On SQLite every storage class qualifies.

**A relationship table** holds one relationship per row:

- `sourceColumn` and `targetColumn` hold the endpoint nodes' keys. Each is a foreign key over exactly that column to the endpoint node's table and key column, with `onDelete: cascade` — the database deletes a node's relationships through it.
- A unique index over exactly the two endpoint columns, with no `where:` — at most one relationship of a type joins an ordered pair.
- Every other column of the row contract is a property of the relationship.

### Indexes the paging promises rest on

The rules above make a graph correct; these make a page cost what [`graph` says it costs](../../graph/docs/graph.md#what-a-page-costs). Nothing checks them — a table without one still answers, by reading and sorting more than a page.

| Read | Index it needs | Who declares it |
| --- | --- | --- |
| `FindNodes`, and every traversal's end nodes | the node key's | the key rule already requires it (primary key or `unique`) |
| `FindRelationships`, unfiltered or by `source:`; an `out` hop | the pair index **listing the source column first** — `columns: [source, target]` | you: the uniqueness rule accepts either order, the listing order does not |
| `FindRelationships` by `target:` alone; an `in` or `both` hop | a second index leading with the target column — `columns: [target, source]` | you |
| a `where` that matches few rows of a large type | an index over the filtered column followed by the key (or the endpoint columns) | you, where the filter is common |

```yaml
indexes:
  knowsPair: { columns: [source, target], unique: true }
  knowsByTarget: { columns: [target, source] }
```

**A find** runs `WHERE key > <cursor> ORDER BY key LIMIT <limit + 1>` — one seek into the key's index and `limit + 1` rows read forward, whatever the table holds before the cursor. With a `where`, rows are read forward in key order until `limit + 1` match.

**A traversal** walks its reach on every page: each hop probes the relationship table once per node reached so far, through the index leading with the column that hop starts from. The end keys after the cursor are then cut to the page and only those nodes are read — with a `where`, every remaining end node is read and filtered first. So a page costs at most one walk of the reach — never more than the first page, whatever else the graph holds — and draining *R* end nodes costs ⌈*R* / `limit`⌉ walks: raise `limit`, or narrow the path, for a wide traversal.

Every step of the statement can be answered from the indexes in the table above, so no page needs to read a typed table whole. Which plan runs is the engine's choice: on a table small enough that reading it whole is cheaper than probing it, the engine may do that, which never costs more than the walk. Without the index a hop starts from, that hop reads the relationship table whole on every page.

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

Resources a store reaches must have distinct resource names, across modules too: the store rules compare a table, a schema or a connection by its resource name, so `GRAPH_TABLE_SHARED` can refuse a store that lists types from two libraries whose table resources share a name, and `GRAPH_TABLE_NOT_IN_SCHEMA` can pass for a same-named resource of another module. `telo check` and creation agree on this.

The two schema rules read the schema's declaration, so they do not run statically while that declaration holds a `!cel` among its top-level fields — the conventional `version: !cel "module.version"` is one — and `telo check` reports the skip (`RESOURCE_RULE_SKIPPED`). The creation-time refusal still applies.

## What each operation runs

Every statement is built when the store (or, for a traversal, the operation) is created, from the declarations: each table named as the store's `schema:` addresses it (see [Namespaces](#namespaces)), column names quoted by the connection's dialect, and nothing from a call's input written as text — an input property name only selects a declared column. A call binds values, and the `where` conditions it asks for.

| Operation | Statement |
| --- | --- |
| `CreateNode` | `INSERT … ON CONFLICT (key) DO NOTHING RETURNING …` — no row returned is `GRAPH_NODE_EXISTS` |
| `MergeNode` | `INSERT … ON CONFLICT (key) DO UPDATE SET <given> RETURNING …` |
| `UpdateNode` / `DeleteNode` | `UPDATE` / `DELETE … WHERE key = ? RETURNING …` — no row is `GRAPH_NODE_NOT_FOUND` |
| `GetNode` | `SELECT … WHERE key = ?` |
| `FindNodes` | `SELECT … WHERE <where> AND key > <cursor> ORDER BY key LIMIT <limit + 1>` — the extra row says whether a next page exists |
| `CreateRelationship` | `INSERT … SELECT` from the two node tables `ON CONFLICT (source, target) DO NOTHING RETURNING …` — an absent endpoint selects no row, and a conflict inserts none; when nothing is returned, one read of the two node tables decides between `GRAPH_NODE_NOT_FOUND` (naming the endpoint) and `GRAPH_RELATIONSHIP_EXISTS` |
| `MergeRelationship` | the same `INSERT … SELECT … DO UPDATE SET <given>` — no row is `GRAPH_NODE_NOT_FOUND` |
| `UpdateRelationship` / `DeleteRelationship` | `UPDATE` / `DELETE … WHERE source = ? AND target = ? RETURNING …` |
| `FindRelationships` | `SELECT … WHERE <endpoints> AND <where> AND (source, target) > (<cursor>) ORDER BY source, target LIMIT <limit + 1>` — with one endpoint given, the cursor continues along the other |
| `DeleteNode`'s relationships | the database's cascade — no statement of the store's |
| `Traverse` | one `WITH RECURSIVE` query: the start node, then one key set per hop — a hop taken once is a join, a repeated hop a recursive CTE over (key, depth) bounded by `maxHops`, whose `UNION` de-duplicates on that pair so a cycle ends at the bound; the end nodes' `where`, order, cursor and `limit + 1` run inside it |

A merge proposes a full row, and the engine checks it before it resolves the conflict, so for each column the merge is not given that is `nullable: false` with no default, the stored value is carried into the proposed row. On a new node that value is missing and the engine refuses the insert — a required property was not given.

Every operation's effect is one statement, so it is atomic on its own; inside a `Sql.Transaction` on the store's connection it runs as part of that transaction instead.

The cursor's tail — the half of a cursor this store owns — is the last returned item's key, or its source and target, in the key tail `@telorun/graph` writes and reads: each value in the value domain's own encoding, so it is bound on the next page as the value it was returned as, whatever its type. A tail that is not one — not that encoding, the wrong number of values, an encoding generation this runtime does not read — is refused before any statement is issued; one that is reaches the statement only as a bound value, exactly as a `key` input does, and what an engine does with a key value of another type is the engine's: it may refuse the statement or order the value by its own cross-type rule. An outcome is always read from the rows a statement returns — never by interpreting a driver error — and a driver error (a constraint the graph model does not describe, a lost connection) reaches the caller unchanged.

## Namespaces

Every table is addressed in the namespace of the store's `schema:`, never by a bare name. The schema resource owns where its tables live, so it renders each table reference: `Postgres.Schema` qualifies it with its `schema:` namespace (`public` when omitted), and `SQLite.Schema`, whose database has one namespace, names the table on its own. What the connection's `search_path` holds, or which role it runs as, does not change which tables a statement reaches.

Schema-per-tenant is one `Postgres.Schema` per tenant namespace, each listing the same tables, and one store per tenant schema. The node and relationship types can be shared between the stores — they describe the tables, not where they are — and a node written through one tenant's store is absent through another's.

A store whose `schema:` is an engine kind from a module that predates table addressing fails when it is created, naming the store, the schema resource and its kind; upgrade that engine module.
