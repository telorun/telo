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
| `FindNodes` | `node` | `where?`, `limit?`, `offset?` | `{ nodes }` | — |
| `CreateRelationship` | `relationship` | `source`, `target`, `properties?` | `{ relationship }` | `GRAPH_RELATIONSHIP_EXISTS`, `GRAPH_NODE_NOT_FOUND` |
| `MergeRelationship` | `relationship` | `source`, `target`, `properties?` | `{ relationship }` | `GRAPH_NODE_NOT_FOUND` |
| `UpdateRelationship` | `relationship` | `source`, `target`, `properties` (≥ 1) | `{ relationship }` | `GRAPH_RELATIONSHIP_NOT_FOUND` |
| `DeleteRelationship` | `relationship` | `source`, `target` | `{ relationship }` (last state) | `GRAPH_RELATIONSHIP_NOT_FOUND` |
| `FindRelationships` | `relationship` | `source?`, `target?`, `where?`, `limit?`, `offset?` | `{ relationships }` | — |
| `Traverse` | `from`, `to`, `hops` | `key`, `where?`, `limit?`, `offset?` | `{ nodes }` | `GRAPH_NODE_NOT_FOUND` |

- **Merge** sets the properties it is given and leaves the others as they are — on a new node or relationship, a property not given takes its default.
- **DeleteNode** removes every relationship that starts or ends at the node. The backend does it in the same operation (for `graph-sql`, the database's cascading foreign keys do).
- **CreateRelationship** refused for a missing endpoint carries `data.endpoint` — `source` or `target` — naming which one. **MergeRelationship** reports the same code without saying which.
- Nodes are returned ordered by key, relationships by source then target. `limit` is at least 1, `offset` at least 0.

No operation opens a transaction of its own. Inside an open transaction on the store's connection (`Sql.Transaction` for `graph-sql`) every write joins it, so a rollback takes the graph's writes with it.

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

The result is the **distinct set** of nodes of type `to` reached at the end of the chain, filtered by `where`, ordered by key and paged; paths are not returned. A repeated hop stops at its `maxHops` whatever cycles the graph holds, and each node is returned once. A start node that exists but reaches nothing is an empty result; a start node that does not exist is `GRAPH_NODE_NOT_FOUND`.

## Rules

Each rule is reported by `telo check` (`RESOURCE_RULE_VIOLATED` / `REFERRER_RULE_VIOLATED`, the code in `data.rule`) and refused again, under the same code, when the resource is created.

| Code | Declared on | Refuses |
| --- | --- | --- |
| `GRAPH_ENDPOINT_NOT_IN_STORE` | `Graph.Relationship` (on the store listing it) | a store listing a relationship type whose `source` or `target` node type it does not list |
| `GRAPH_TYPE_NOT_IN_STORE` | every operation | a node or relationship type its store does not list |
| `GRAPH_HOPS_DISCONNECTED` | `Graph.Traverse` | hops that do not chain from `from` to `to` in their directions |
| `GRAPH_HOP_REPEAT_MIXED_TYPES` | `Graph.Traverse` | `both`, or `maxHops` > 1, on a relationship between two different node types |
| `GRAPH_HOP_RANGE_INVALID` | `Graph.Traverse` | `maxHops` below `minHops` |

A backend declares its own storage rules on its own kinds — `graph-sql`'s are in its docs.

A rule reading a declaration another module exported can fail to evaluate rather than run (`RESOURCE_RULE_INVALID`): today the analyzer hands such a declaration's references to a rule in their unresolved form. The creation-time refusal still applies.
