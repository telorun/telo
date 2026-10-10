# Graph

A knowledge graph for Telo: typed entities (nodes) and typed, directed links between them (relationships), written, read, filtered and traversed through operations whose inputs and outputs are typed from the declared model. `graph` is backend-neutral — it owns the abstracts, the twelve operations and the store contract. A backend supplies the storage: `graph-sql` keeps the graph in ordinary SQL tables on SQLite or PostgreSQL, and [`graph-layers`](../graph-layers/README.md) keeps several graphs as layers built on one another.

## Why use this

- **Typed from the model** — a node type names the property that identifies it (`key:`); a relationship type names its `source` and `target` node types. Every operation's `key`, `properties`, `source`, `target` and `where` is typed from those declarations, so a misspelled property or a key of the wrong type fails `telo check` on its own line, and a computed one is refused at dispatch (`ERR_INPUT_INVALID`).
- **Checked against the store** — an operation naming a type its store does not list, a store holding a relationship whose endpoints it does not hold, and a traversal whose hops do not chain from `from` to `to` are refused by `telo check` and again when the resource is created.
- **Outcomes, not driver errors** — a missing node, a duplicate, a missing endpoint each arrive as a declared code (`GRAPH_NODE_NOT_FOUND`, …) a `try:` step or a route's `catches:` handles.
- **Backend-neutral** — a FalkorDB or Neo4j backend implements the same store contract; see [the store contract](docs/store-contract.md).

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `Graph.Store` | Provider (abstract) | A graph: the node types (`nodes:`) and relationship types (`relationships:`) it holds. |
| `Graph.Node` | Provider (abstract) | A node type: `key:` names its identifying property. |
| `Graph.Relationship` | Provider (abstract) | A relationship type: `source:` / `target:` node types (may be the same type). |
| `Graph.CreateNode` | Invocable | Create a node; `GRAPH_NODE_EXISTS` when its key is taken. |
| `Graph.MergeNode` | Invocable | Create or update a node, setting only the properties given. |
| `Graph.UpdateNode` | Invocable | Update a node's properties; `GRAPH_NODE_NOT_FOUND`. |
| `Graph.DeleteNode` | Invocable | Delete a node and every relationship touching it; `GRAPH_NODE_NOT_FOUND`. |
| `Graph.GetNode` | Invocable | Read a node by key; `GRAPH_NODE_NOT_FOUND`. |
| `Graph.FindNodes` | Invocable | List nodes matching a filter, by key, a page at a time by cursor; `GRAPH_CURSOR_INVALID`. |
| `Graph.CreateRelationship` | Invocable | Link two nodes; `GRAPH_RELATIONSHIP_EXISTS`, `GRAPH_NODE_NOT_FOUND` (with `data.endpoint`). |
| `Graph.MergeRelationship` | Invocable | Create or update a link; `GRAPH_NODE_NOT_FOUND`. |
| `Graph.UpdateRelationship` | Invocable | Update a link's properties; `GRAPH_RELATIONSHIP_NOT_FOUND`. |
| `Graph.DeleteRelationship` | Invocable | Delete a link; `GRAPH_RELATIONSHIP_NOT_FOUND`. |
| `Graph.FindRelationships` | Invocable | List links, optionally from a source / to a target, filtered, a page at a time by cursor; `GRAPH_CURSOR_INVALID`. |
| `Graph.Traverse` | Invocable | The distinct nodes reached from a start node over a chain of hops, a page at a time by cursor; `GRAPH_NODE_NOT_FOUND`, `GRAPH_CURSOR_INVALID`. |

## Example

With a store `kb` holding a `person` node type and a `knows` relationship type (declared by a backend — see [`graph-sql`](../graph-sql/README.md)):

```yaml
kind: Graph.CreateNode
metadata: { name: addPerson }
store: !ref kb
node: !ref person
---
kind: Graph.Traverse
metadata: { name: friendsOfFriends }
store: !ref kb
from: !ref person
to: !ref person
hops:
  - relationship: !ref knows
    minHops: 2
    maxHops: 2
---
kind: Run.Sequence
metadata: { name: demo }
steps:
  - name: add
    invoke: !ref addPerson
    inputs: { key: alice, properties: { name: Alice } }
  - name: reach
    invoke: !ref friendsOfFriends
    inputs: { key: alice, where: { gte: { age: 18 } }, limit: 20 }
  - name: more
    when: !cel "has(steps.reach.result.next)"
    invoke: !ref friendsOfFriends
    inputs:
      key: alice
      where: { gte: { age: 18 } }
      limit: 20
      cursor: !cel "steps.reach.result.next"
```

`steps.reach.result.nodes` is `[{ key, properties }]`, typed from `person` (a layered store adds `origin`, the layer each node came from) — one page of at most `limit` (100 when omitted, 1000 at most). `next` is present only when more exist, and is passed back as `cursor`, with the same inputs, to read the page after.

## Runtime

This module requires telo **0.108.0 or newer** (`requires: telo: ">=0.108.0"`): a listing's cursor carries keys in an encoding the runtime first provides in that release. Every backend imports this module, so that is the floor of any graph.

## Docs

- [Model, operations, filters and traversal](docs/graph.md)
- [The store contract — implementing a backend](docs/store-contract.md)
