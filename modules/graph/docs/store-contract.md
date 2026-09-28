---
description: "Implementing a graph backend: the kinds a backend declares, the row projections that type the operations, and the @telorun/graph store interface — one method per operation, returning values or outcomes, never error codes."
sidebar_label: Graph store contract
---

# The graph store contract

`graph` owns the model, the operations and the codes they throw. A backend — `graph-sql` today, a FalkorDB or Neo4j module tomorrow — owns storage. This page is what a backend implements.

## The kinds a backend declares

1. **A store kind** extending `Graph.Store`, which restates `nodes:` / `relationships:` as references to the backend's own node and relationship kinds, plus whatever configuration the backend needs (a connection, a database name).
2. **Node kinds** extending `Graph.Node`, carrying `key:` — the NAME of the identifying property — and whatever says where nodes live (a table, a label).
3. **Relationship kinds** extending `Graph.Relationship`, carrying `source:` / `target:` references to the backend's node kinds, and whatever says where relationships live.
4. **A row projection on each node and relationship kind**, so the operations are typed. Either the kind's own `x-telo-schema-projection` over the properties it declares, or a derived one: `x-telo-schema-projection-from` on the kind document (`graph-sql`'s node kind derives from its table: `x-telo-schema-projection-from: /table`). The projection of a node kind must hold the key property; a relationship kind's projection holds only the relationship's own properties.

The operations then type themselves: a node's `key` is `{ from: /node, pick: /node/key }`, its `properties` `{ from: /node, omit: [/node/key] }`, a relationship's endpoints are picked from the endpoint node types' projections, and its `properties` are the relationship kind's projection.

A backend declares no referrer rules on its relationship kind — `Graph.Relationship`'s endpoint-membership rule is inherited, and a child's rules replace its parent's per annotation key. It declares its own storage rules as resource rules on its own kinds, each with a creation-time twin.

## The store interface — `@telorun/graph`

The backend's controller bundle imports the interface by the specifier `@telorun/graph` (resolved through the module's `exports.code`, never inlined). The store instance implements `GraphStore`:

- `nodes` / `relationships` — the node and relationship type INSTANCES the store lists. The operations check membership by identity, so these are the same instances Phase-5 injection hands the operations.
- One method per operation, each receiving the backend's own type instances plus plain values:

| Method | Returns |
| --- | --- |
| `createNode(type, key, properties, ctx)` | `found` with the node, or `exists` |
| `mergeNode(type, key, properties, ctx)` | `found` |
| `updateNode(type, key, properties, ctx)` | `found`, or `absent` |
| `deleteNode(type, key, ctx)` | `found` with the last state, or `absent` |
| `getNode(type, key, ctx)` | `found`, or `absent` |
| `findNodes(type, where, page, ctx)` | nodes ordered by key |
| `createRelationship(type, source, target, properties, ctx)` | `found`, `exists`, or `endpointAbsent` naming `source` / `target` |
| `mergeRelationship(type, source, target, properties, ctx)` | `found`, or `absent` when an endpoint is missing |
| `updateRelationship(type, source, target, properties, ctx)` | `found`, or `absent` |
| `deleteRelationship(type, source, target, ctx)` | `found` with the last state, or `absent` |
| `findRelationships(type, { source?, target? }, where, page, ctx)` | relationships ordered by source then target |
| `prepareTraversal(spec)` | the backend's compiled traversal — called once, when the operation is created; performs no I/O |
| `traverse(prepared, key, where, page, ctx)` | `found` with the distinct end nodes ordered by key, or `absent` when the start node is missing |

What an implementation must hold to:

- **Outcomes, never codes.** A missing node, a duplicate, a missing endpoint is an outcome; which code it earns is `graph`'s decision, made once for every backend. A failure that is not an outcome — a lost connection, a constraint the model does not describe — is thrown as it arrives, never swallowed and never re-labelled as an outcome.
- **Values as the operations return them**: a node is `{ key, properties }`, a relationship `{ source, target, properties }`; a property with no value is absent rather than null.
- **Filters** (`where`): operator-first, `eq` / `ne` / `lt` / `lte` / `gt` / `gte`, each a partial property map, all ANDed; `eq` of null matches an absent property, `ne` of null a present one, and no other comparison matches an absent property. A property name selects a declared property and is never written into a query as text.
- **Deletes**: deleting a node removes every relationship touching it, as part of the same operation.
- **Transactions**: join whatever transaction the caller's context holds (`ctx`), open none.
- **Traversal**: `spec` arrives validated — its hops chain from `from` to `to`, and a repeated hop (`both`, or `maxHops` > 1) joins one node type. Return the distinct end nodes; a repeated hop is bounded by its `maxHops` whatever cycles the data holds.
- **Creation**: the store runs `assertEndpointsListed` (exported by `@telorun/graph`) when it is created, the twin of `GRAPH_ENDPOINT_NOT_IN_STORE`.

`isGraphStore`, `isGraphNodeType` and `isGraphRelationshipType` are the guards the operations resolve their slots with; a backend's instances must satisfy them.
