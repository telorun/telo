---
description: "Layered graphs in SQL: how layers share a table, the structural rules a layered table must satisfy, overlay by precedence as index probes, and the cost of a page."
sidebar_label: Layered SQL graphs
---

# `GraphLayersSql`

> The abstracts here are extended by a strategy module's kinds. Examples use the SQLite strategy under alias `Layers`.

## How layers are stored

Every node type and relationship type is **one table shared by every layer**. A row is one layer's *statement* about one key:

- `graph_layer` — the layer's name;
- `graph_effect` — `stated` (the row is the value) or `removed` (the row hides whatever the layers beneath state for the key);
- the author's own columns.

A node table is unique on (`graph_layer`, key); a relationship table on (`graph_layer`, source, target), with a second index on (`graph_layer`, target, source). There is no bookkeeping table: a layer exists as soon as a store names it.

The two `graph_` columns and those indexes are declared by the strategy module's table kinds, as internal columns — so they are created and migrated by the engine schema like the rest of the table, and appear in no operation's contract. The module issues no DDL.

A key or endpoint column may be any type whose values the engine returns as its projected type. On PostgreSQL `date`, `timestamp`, `timestamptz` and `interval` columns are not such types today — the driver returns host dates where the table projects text — so they cannot be node keys or endpoints. Nor can `bigint` and `numeric` columns there: the driver returns them as text where the table projects a number. An operation that returns such a key is refused by its own output contract (`ERR_OUTPUT_INVALID`), and a listing that has a further page past a host date by the cursor's encoding (`ERR_TYPED_FRAME_UNENCODABLE`) — each a coded error, never a node whose key would not address it. On SQLite every storage class qualifies.

A relationship's endpoint columns hold **logical keys**. There is no foreign key between a relationship table and a node table: an endpoint may be stated by any layer beneath, which no foreign key can express. The store checks endpoints when a relationship is created or merged, and resolves them again on every read: a relationship is in a view only while both its endpoints are.

## Rules

Three owners, by who has the requirement: what any SQL table must satisfy is the engine table's; what a layered *type* requires of its table is declared here; and the reserved `graph_` namespace is the table kind's own schema.

### Rules of the layered types

Declared once on the abstracts, inherited by every strategy module's kinds. Each is reported by `telo check` (`RESOURCE_RULE_VIOLATED`, the code in `data.rule`) and refused again, under the same code, when the resource is created.

| Code | On | Refuses |
| --- | --- | --- |
| `GRAPH_NODE_KEY_UNKNOWN_COLUMN` | node | `key` names a column the table does not declare |
| `GRAPH_NODE_KEY_MISMATCH` | node | the node's `key` is not its table's `key` |
| `GRAPH_NODE_KEY_NOT_LAYERABLE` | node | the key column admits NULL, or is `primaryKey`, `unique` or `identity` |
| `GRAPH_TABLE_UNIQUE_DECLARED` | node, relationship | a `primaryKey` or `unique` column, or a unique index, declared by the author |
| `GRAPH_ENDPOINT_UNKNOWN_COLUMN` | relationship | an endpoint column the table does not declare, or one column named for both |
| `GRAPH_ENDPOINT_MISMATCH` | relationship | endpoint columns that are not its table's |
| `GRAPH_ENDPOINT_NULLABLE` | relationship | an endpoint column that admits NULL |
| `GRAPH_TABLE_NOT_IN_SCHEMA` | store | a type whose table the store's schema does not list |
| `GRAPH_SCHEMA_CONNECTION_MISMATCH` | store | a schema on another connection than the store's |
| `GRAPH_TABLE_SHARED` | store | two types over one table |
| `GRAPH_BASE_STORE_MISMATCH` | store | a base on another connection or schema |
| `GRAPH_BASE_LAYER_DUPLICATE` | store | the same layer twice among `bases:`, or a base naming the store's own `layer` |

Resources a store reaches must have distinct resource names, across modules too: the store rules compare a table, a schema, a connection or a base by its resource name, so `GRAPH_TABLE_SHARED` can refuse a store that lists types from two libraries whose table resources share a name, and `GRAPH_TABLE_NOT_IN_SCHEMA` can pass for a same-named resource of another module. `telo check` and creation agree on this.

Why nothing may be unique: a layer that restates or hides a node writes a second row for the same key, so any value unique across the table would refuse it. Uniqueness belongs to the pair (`graph_layer`, key), which the table kind declares. The key must be `nullable: false` for the same pair to identify a row.

A layer two bases share deeper down is legal — it takes its lowest place in the stack. What `GRAPH_BASE_LAYER_DUPLICATE` refuses is one layer named twice among a store's direct bases, a direct base naming the store's own layer, and — **at creation only** — the store's own layer reached anywhere deeper, through a base of a base. That last case is a cycle among layer *names* through two store resources, and `telo check` cannot see it for the reason it cannot see `GRAPH_ENDPOINT_TYPE_MISMATCH`: a rule reads one reference deep.

A node naming the same undeclared key as its table is reported twice at check — `GRAPH_NODE_KEY_UNKNOWN_COLUMN` on the node and `SQL_INDEX_UNKNOWN_COLUMN` on the table. Boot stops at the table, which is created first.

### The table kinds

**A strategy table kind is held to its engine table's rules, restated on its own fields, and reserves the `graph_` prefix in its schema.** It declares no graph rule.

- **The `graph_` prefix.** A column or an index whose name begins `graph_` is a `SCHEMA_VIOLATION`, at `telo check` and again when the table is created, before anything is mapped onto the engine table. An index may *name* the bookkeeping columns `graph_layer` and `graph_effect`.
- **The engine table's rules.** A kind that maps onto its parent with `base:` has a schema of its own and inherits no rule, so each strategy table kind restates, under the engine's own codes, every `Sql.Table` rule its author surface can still violate:

| Code | On a strategy table kind |
| --- | --- |
| `SQL_INDEX_UNKNOWN_COLUMN` | an index naming a column that is neither the author's nor a bookkeeping column; `key`, `sourceColumn` or `targetColumn` naming no declared column; one column named for both endpoints |
| `SQL_RENAME_FROM_SELF`, `SQL_RENAME_SOURCE_STILL_DECLARED` | a column's `renamedFrom`, read against the author's columns and the bookkeeping ones |
| `SQL_COMPOSITE_PRIMARY_KEY`, `SQL_TABLE_RENAME_FROM_SELF` | as on the engine table |
| `SQL_ENUM_NOT_DECLARED`, `SQL_TABLE_RENAME_SOURCE_STILL_DECLARED`, `SQL_TABLE_RENAME_SOURCE_CLAIMED_TWICE` | as on the engine table, judged against the engine schema that lists the table |

Rules over `foreignKeys`, `seeds` and `internalColumns` are not restated: the kinds do not offer those fields. At creation the engine table judges the mapped declaration exactly as it judges a plain table of its own, so a mistake is refused there as it would be for one — in the engine's own words. One clause has no twin in the engine: a relationship table naming one column for both endpoints is refused at creation by the relationship type over it (`GRAPH_ENDPOINT_UNKNOWN_COLUMN`), not by the table.

The restated column, index and check vocabulary, the row projection and this rule list are kept in step with the engine by each strategy module's unit test (`nodejs/tests/engine-vocabulary.test.ts`): it reads both manifests and fails when an entry differs from the engine's or when the engine table gains a rule that is neither restated nor on the test's written exclusion list.

**Creation only — `GRAPH_ENDPOINT_TYPE_MISMATCH`**: an endpoint column whose type differs from the endpoint node's key column. A rule reads the declarations its own references name, one level deep, and this comparison needs the endpoint node's *table* — two references away — so `telo check` cannot make it. It is refused when the relationship type is created.

What the analyzer refuses on its own, with no rule:

- a plain engine table at a node or relationship type's `table` is `REFERENCE_KIND_MISMATCH` — the slot names the strategy module's own table kind, which is what guarantees the bookkeeping columns exist;
- stores built on each other are `DEPENDENCY_CYCLE`, since a base is a dependency;
- `seeds`, `foreignKeys` or `internalColumns` written on a strategy table kind are `SCHEMA_VIOLATION` — the kinds do not offer them.

## Reads

A store's stack is its own layer, then each base in order followed by that base's stack. A layer reached more than once — two bases built on the same layer — has one place, the lowest of them, so every layer outranks the layers it is built on. For one key the statement of the first layer in the stack wins; a `removed` winner makes the key absent. A relationship is in the view when its winner is `stated` and both its endpoint nodes resolve. Layer names are bound values in every statement, never statement text.

- **A lookup by key** reads the key in the stack's layers and takes the highest: one index probe per layer.
- **A listing** has each layer read its own first `limit` visible winners in order through its (`graph_layer`, key) index, each row probing the layers above it; the page is cut from their union. Every such probe — in a listing, in endpoint resolution, and where a traversal asks whether a row is shadowed — is one shape, a scalar subquery (`(SELECT … LIMIT 1) IS NULL`), never `NOT EXISTS`: a planner may answer an anti-join by hashing the whole layer it probes, and on a table of a few thousand rows it does, so a page would cost the table rather than its `limit`. A property filter is applied after the winner is decided, so it judges the winner only. A relationship listing also resolves each row's two endpoints — one probe of the node table's (`graph_layer`, key) index per layer of the stack — and passes over a row whose endpoint does not resolve.
- **A traversal** is one statement: the start node as the stack resolves it, one key set per hop — a relationship row followed only when it is the visible winner for its pair and the node it leads to resolves — then one page of the end nodes the stack resolves among the keys reached. Every set holds resolved nodes only, so a walk never passes through a node the view lacks, and each reached node is resolved once. A repeated hop is a recursive walk bounded by its `maxHops`.

No form resolves the whole stack before a page or a hop.

## Writes

A write states only in the store's own layer, and every operation is atomic: it joins the caller's `Sql.Transaction` when one is open on the connection, and otherwise runs in a transaction of its own that never outlives the call.

**Every write that depends on the layer's own row for a key is a conditional statement against that row** — one, except a merge of a key the view does not show, which is two. The layer's unique index over (`graph_layer`, key) is where concurrent writers of one key meet: whichever arrives second is answered by the statement's conflict arm, against the row the first left. Each statement's result is read, and no row returned is an outcome of the contract — `exists` or `absent` — never an error and never a success. The store retries nothing: where a second statement follows, it belongs to the outcome the first one returned.

| Operation | Statement | No row returned |
| --- | --- | --- |
| merge, onto what the view shows | an insert of the stated winner of the store's whole view, read inside the statement, with the given columns. It proposes nothing when the view shows nothing for the key. On a conflict an own `stated` row takes the given columns — with none given, it is returned as it is | the view does not show the key, so the next statement runs |
| merge, as a new value — only when the first returned no row | an insert naming only the given columns, so the engine applies the declared default of every other column. On a conflict the layer's row becomes `stated` with the given columns: on an own `stated` row the other columns stay, on an own `removed` row each other column takes its default — nothing of what the removal hid | cannot happen: the statement always returns the row the layer then holds |
| update of this layer's own value | a conditional update of the layer's `stated` row | `absent` — the layer removed the key meanwhile |
| update of a value from beneath | an insert of the winner among the layers beneath, read inside the statement, with the change; on a conflict an own `stated` row takes the given columns | `absent` — nothing beneath states the key any more, or the layer removed it meanwhile |
| create | one insert of the given values; on a conflict an own `removed` row is replaced whole and becomes `stated` | `exists` — the layer states the key |
| delete | the layer's own `stated` row is deleted; then, where the layers beneath still state the key, one upsert of a `removed` row carrying the hidden row's values, whose conflict arm turns a row the layer holds into the removal | the delete answers `found` once a statement that makes the key absent has returned its row, and `absent` when neither did |
| delete of a node | additionally, for every relationship type touching the node type: this layer's own `stated` rows at that endpoint are deleted. Nothing is written for relationships the layers beneath state, and this layer's own `removed` relationship rows are left as they are | — |
| retract | this layer's row for the key is deleted, whatever it says — exactly that one statement | `notStated` |

A create or an update first reads what the view shows for the key, to answer `exists` or `absent` for a key another layer decides; that read chooses the statement and never its outcome. A relationship's endpoint check is a read in the same atomic operation, before its statement.

A merge is two statements where the view does not show the key because a statement's column list is fixed, and only the engine knows a column's default — a literal, an expression, an identity, an enum cast. The store applies one by not naming the column. So a merge or create of a key the view does not show — never stated, or hidden by the layer's own removal — stores and returns the given properties plus the declared default of every other property; a property with neither is absent, and nothing is taken from a statement the removal hid. Whatever lands between the two statements leaves a result equal to some serial order:

| What lands between the two statements | Result | The serial order it equals |
| --- | --- | --- |
| a base states the key | a new node with defaults | the merge, then the base's write |
| a racing merge inserts the layer's row | the given columns set on that row | the other merge, then this one |
| a racing delete leaves a removal | the given values plus defaults | the delete, then the merge |

A `removed` row keeps the hidden row's column values, so a column declared `nullable: false` holds in it too. A property that is `nullable: false` with no default must be given when the view does not show the key; otherwise the engine's own constraint error surfaces.

## Paging and cost

The cursor tail is the last key (for relationships, source and target), in the key tail `@telorun/graph` writes and reads — each value in the value domain's own encoding, so a listing resumes after any key an operation returns. A tail that is not one — not that encoding, the wrong number of values, an encoding generation this runtime does not read — is `cursorInvalid` before any statement is issued; a readable one reaches the statement only as a bound value, in the seek comparison. The seek is repeated inside every probe of a higher layer, so a probe never reads a layer from its beginning.

- **A node page** costs in proportion to `limit` × the stack's depth — never to the table's size or to how far the cursor has come. It rests on the (`graph_layer`, key) index. With a `where`, a layer reads forward until it has `limit` matches, so a filter that matches rarely reads more; declare an index of your own for a property a filter reads.
- **A relationship page** costs in proportion to `limit` and to the square of the stack's depth: at most depth × (`limit` + 1) relationship rows, and for each of a row's two endpoints one node row per layer — depth × (`limit` + 1) × (1 + 2 × depth) rows in all. It rests on (`graph_layer`, source, target), or (`graph_layer`, target, source) when only `target` is given, and on the node tables' (`graph_layer`, key). Relationships whose endpoints do not resolve are passed over as rows a `where` rejects are.
- **A traversal page** costs at most one walk of its reach from the start node, each hop probing the relationship indexes for the keys reached, in every layer of the stack, and resolving each reached node once. No page costs more than the first, whatever else the tables hold. Draining *R* end nodes costs ⌈*R* / `limit`⌉ walks.
- **A node delete** writes the node's own row and deletes this layer's relationships at that endpoint; it writes nothing in proportion to how many relationships the layers beneath state for the node.

A current store pins nothing: a listing reads each page against the layers as they then are. No key is returned twice, and every key visible throughout is returned exactly once.

## For a strategy module

A strategy module holds concrete kinds that `extends` these abstracts, narrows each slot to its own kinds, and names the shared controllers by re-exporting them from `@telorun/graph-layers-sql` in its own bundle. Its table kinds `extends` the engine's `Table` with `base:`, forwarding the author's `columns` bare and adding `graph_layer` / `graph_effect` under `internalColumns` plus the indexes named `graph_<table>_…`. A table kind declares its own row projection over `columns`, since a projection is read from the kind's own document, reserves `graph_` in the property names of `columns` and `indexes`, restates the engine table's rules as [above](#the-table-kinds), and ships the unit test that holds all of it to the engine. The concrete node, relationship and store kinds declare no rule: one of their own would replace every rule they inherit.

The code library `@telorun/graph-layers-sql` exports the controllers a strategy module re-exports — `Node`, `Relationship`, `CurrentStore`, `DraftedStore` and `RevisionedStore` — and nothing else: everything else in it is internal and may change in any release. A strategy for another engine re-exports these under its own kinds; a strategy that stores a graph another way implements the [`graph-layers` store interface](../../graph-layers/docs/store-contract.md) under one of the three abstracts.
