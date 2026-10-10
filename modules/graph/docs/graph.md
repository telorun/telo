---
description: "Graph: typed nodes and relationships, the node / relationship / traversal operations, operator-first filters, identity, and the rules telo check enforces on a graph model."
sidebar_label: Graph
---

# `Graph`

> Examples assume this module is imported under alias `Graph` and a backend under `GraphSql`. Substitute if you import under different names.

## The model

A graph holds **node types** and **relationship types**, declared by a backend and listed by a store:

- **`Graph.Node`** — `key:` names the property that identifies a node of the type. The key is always supplied by whoever writes the node, never generated, and no two nodes of the type share one. A node's value is `{ key, properties }`; `properties` holds every other property it has. A property with no value is absent, never null.
- **`Graph.Relationship`** — `source:` and `target:` name the node types it joins; they may be the same type, and a self-loop is allowed. At most one relationship of a type joins an ordered pair — parallel edges are modelled as an intermediate node type. A relationship's value is `{ source, target, properties }`: the endpoint keys, and the relationship's own properties.
- **`Graph.Store`** — `nodes:` and `relationships:` list the types it holds. Every operation names a store and a type the store lists.

A node or relationship value may also carry **`origin`** (a string): the layer it was resolved from. Only a layered store sets it — see [`graph-layers`](../../graph-layers/README.md); a plain backend such as `graph-sql` never does, and the member is then absent.

The key's type is read from the node type's declaration, and an endpoint's type from the endpoint node type's key, so the same operation is typed differently for every node type it is pointed at.

## Operations

Every operation is invocable, takes `store:` plus the type it works on, and declares the codes it throws.

| Operation | Config | Inputs | Output | Throws |
| --- | --- | --- | --- | --- |
| `CreateNode` | `node` | `key`, `properties?` | `{ node }` | `GRAPH_NODE_EXISTS` |
| `MergeNode` | `node` | `key`, `properties?` | `{ node }` | — |
| `UpdateNode` | `node` | `key`, `properties` (≥ 1) | `{ node }` | `GRAPH_NODE_NOT_FOUND` |
| `DeleteNode` | `node` | `key` | `{ node }` (last state) | `GRAPH_NODE_NOT_FOUND` |
| `GetNode` | `node` | `key` | `{ node }` | `GRAPH_NODE_NOT_FOUND` |
| `FindNodes` | `node` | `where?`, `limit?`, `cursor?` | `{ nodes, next? }` | `GRAPH_CURSOR_INVALID` |
| `CreateRelationship` | `relationship` | `source`, `target`, `properties?` | `{ relationship }` | `GRAPH_RELATIONSHIP_EXISTS`, `GRAPH_NODE_NOT_FOUND` |
| `MergeRelationship` | `relationship` | `source`, `target`, `properties?` | `{ relationship }` | `GRAPH_NODE_NOT_FOUND` |
| `UpdateRelationship` | `relationship` | `source`, `target`, `properties` (≥ 1) | `{ relationship }` | `GRAPH_RELATIONSHIP_NOT_FOUND` |
| `DeleteRelationship` | `relationship` | `source`, `target` | `{ relationship }` (last state) | `GRAPH_RELATIONSHIP_NOT_FOUND` |
| `FindRelationships` | `relationship` | `source?`, `target?`, `where?`, `limit?`, `cursor?` | `{ relationships, next? }` | `GRAPH_CURSOR_INVALID` |
| `Traverse` | `from`, `to`, `hops` | `key`, `where?`, `limit?`, `cursor?` | `{ nodes, next? }` | `GRAPH_NODE_NOT_FOUND`, `GRAPH_CURSOR_INVALID` |

- **Merge** sets the properties it is given and leaves the others as they are — on a new node or relationship, a property not given takes its default.
- **DeleteNode** removes every relationship that starts or ends at the node. The backend does it in the same operation (for `graph-sql`, the database's cascading foreign keys do). A layered store cascades nothing: a relationship is out of its view while either endpoint does not resolve there, and is back when it does — see [`graph-layers`](../../graph-layers/docs/graph-layers.md).
- **CreateRelationship** refused for a missing endpoint carries `data.endpoint` — `source` or `target` — naming which one. **MergeRelationship** reports the same code without saying which.
- Nodes are returned ordered by key, relationships by source then target, traversal end nodes by key — one page at a time (see [Paging](#paging)).

Every operation is atomic. Inside an open transaction on the store's connection (`Sql.Transaction` for `graph-sql`) it joins that transaction, so a rollback takes the graph's writes with it; with none open it commits on its own.

## Paging

`FindNodes`, `FindRelationships` and `Traverse` return one page per call.

- **`limit`** — the most items in the page: an integer from 1 to 1000, **100 when omitted**. No call reads a whole type.
- **`next`** — present in the result only when more exist. Pass it back as **`cursor`** to read the page after; the last page has no `next`.
- **`cursor`** — the `next` of an earlier page, unchanged. It is opaque: nothing in it is meant to be read, built or stored as data.

```yaml
steps:
  - name: page
    invoke: !ref findPeople
    inputs: { limit: 50 }
  - name: rest
    while: !cel "has(steps.page.result.next)"
    do:
      - name: page
        invoke: !ref findPeople
        inputs: { limit: 50, cursor: !cel "steps.page.result.next" }
```

Following `next` to the end returns every match exactly once, in order, with no duplicate and no gap. `limit` may differ from one page to the next.

A cursor resumes one listing through one store. It is a position, not a permission. A caller that receives `GRAPH_CURSOR_INVALID` restarts the listing; a cursor is not kept across a new version of the application.

**A cursor belongs to the listing that issued it**: the same operation kind, the same store, the same type (for a traversal, the same declared path and start key), the same `source` / `target` and the same `where`. Anything else — a cursor from another listing, a malformed one, one written by a runtime whose cursor format this one does not read — is `GRAPH_CURSOR_INVALID`. `where` is compared by meaning, not by spelling: key order and an operator holding no property make no difference.

There is no `offset` and no total count. An offset makes page *n* cost *n* pages; a cursor resumes where the last page ended.

### What a listing sees while the graph changes

A listing is not a snapshot: each page reads the graph as it is when that page is asked for. An item present for the whole listing is returned exactly once. One created or deleted while the listing is in progress is returned if it sorts after the cursor at the time its page is read, and is not if it sorts before — it is never returned twice. A listing that must see one state reads all of its pages inside one transaction at an isolation level that holds a snapshot.

### What a page costs

These are the backend's promises, stated here because they are part of what paging means; [`graph-sql`](../../graph-sql/docs/sql-graph.md) says which indexes they rest on.

- **`FindNodes`** seeks to the cursor and reads forward: the cost is proportional to `limit`, never to the size of the type or to the pages already read.
- **`FindRelationships`** — the same, along (source, target).
- **`Traverse`** walks the traversal's reach from the start node on every page: a page costs at most one walk — never more than the first page, whatever else the graph holds — and is not proportional to `limit`. Draining *R* end nodes costs ⌈*R* / `limit`⌉ walks, so for a wide traversal raise `limit` or narrow the path.

With a `where`, a find reads forward until it has `limit` matches, so a filter that matches rarely reads more than `limit` items to fill a page.

## Filters — `where`

`where` is operator-first: each of `eq`, `ne`, `lt`, `lte`, `gt`, `gte` holds a partial property map typed from the node or relationship type, and every comparison is ANDed.

```yaml
inputs:
  where:
    gte: { age: 30 }
    ne: { name: Bob, email: null }
```

- `eq` of `null` matches a node or relationship **without** the property; `ne` of `null` matches one **with** it.
- No other comparison ever matches a missing property — `lt: { age: null }` matches nothing, and `ne: { name: Bob }` does not match a node with no name.
- A node's `where` filters its properties, never its key (use `GetNode`); a relationship's filters its own properties, and `source:` / `target:` select by endpoint.

## Traversal

`Graph.Traverse` declares a path as a list of hops. Each hop follows one relationship type in a `direction` — `out` (source to target, the default), `in` (target to source) or `both` — between `minHops` (default 1) and `maxHops` (default `minHops`) times:

```yaml
kind: Graph.Traverse
metadata: { name: collaborators }
store: !ref kb
from: !ref person
to: !ref person
hops:
  - relationship: !ref authored            # person → document
  - relationship: !ref authored
    direction: in                          # document → person
```

The result is the **distinct set** of nodes of type `to` reached at the end of the chain, filtered by `where`, ordered by key and returned a [page](#paging) at a time; paths are not returned. A repeated hop stops at its `maxHops` whatever cycles the graph holds, and each node is returned once. A start node that exists but reaches nothing is an empty result; a start node that does not exist is `GRAPH_NODE_NOT_FOUND`.

## Rules

Each rule is reported by `telo check` (`RESOURCE_RULE_VIOLATED` / `REFERRER_RULE_VIOLATED`, the code in `data.rule`) and refused again, under the same code, when the resource is created.

| Code | Declared on | Refuses |
| --- | --- | --- |
| `GRAPH_ENDPOINT_NOT_IN_STORE` | `Graph.Relationship` (on the store listing it) | a store listing a relationship type whose `source` or `target` node type it does not list |
| `GRAPH_TYPE_NOT_IN_STORE` | every operation | a node or relationship type its store does not list |
| `GRAPH_HOPS_DISCONNECTED` | `Graph.Traverse` | hops that do not chain from `from` to `to` in their directions |
| `GRAPH_HOP_REPEAT_MIXED_TYPES` | `Graph.Traverse` | `both`, or `maxHops` > 1, on a relationship between two different node types |
| `GRAPH_HOP_RANGE_INVALID` | `Graph.Traverse` | `maxHops` below `minHops` |

A backend declares its own storage rules on its own kinds — `graph-sql`'s are in its docs, a layered SQL graph's in [`graph-layers-sql`](../../graph-layers-sql/README.md).

A rule reads a declaration another module exported as that module wrote it: its references resolve in the declaring module's scope, so the rule runs at check exactly as it does over a local declaration.
