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
| `findNodes(type, where, page, ctx)` | `found` with a page of nodes ordered by key, or `cursorInvalid` |
| `createRelationship(type, source, target, properties, ctx)` | `found`, `exists`, or `endpointAbsent` naming `source` / `target` |
| `mergeRelationship(type, source, target, properties, ctx)` | `found`, or `absent` when an endpoint is missing |
| `updateRelationship(type, source, target, properties, ctx)` | `found`, or `absent` |
| `deleteRelationship(type, source, target, ctx)` | `found` with the last state, or `absent` |
| `findRelationships(type, { source?, target? }, where, page, ctx)` | `found` with a page of relationships ordered by source then target, or `cursorInvalid` |
| `prepareTraversal(spec)` | the backend's compiled traversal — called once, when the operation is created; performs no I/O |
| `traverse(prepared, key, where, page, ctx)` | `found` with a page of the distinct end nodes ordered by key, `absent` when the start node is missing, or `cursorInvalid` |

What an implementation must hold to:

- **Outcomes, never codes.** A missing node, a duplicate, a missing endpoint is an outcome; which code it earns is `graph`'s decision, made once for every backend. A failure that is not an outcome — a lost connection, a constraint the model does not describe — is thrown as it arrives, never swallowed and never re-labelled as an outcome.
- **Values as the operations return them**: a node is `{ key, properties, origin? }`, a relationship `{ source, target, properties, origin? }`; a property with no value is absent rather than null. `origin` is the name of the layer a value was resolved from: a layered store sets it on every value, any other backend leaves it out.
- **Filters** (`where`): operator-first, `eq` / `ne` / `lt` / `lte` / `gt` / `gte`, each a partial property map, all ANDed; `eq` of null matches an absent property, `ne` of null a present one, and no other comparison matches an absent property. A property name selects a declared property and is never written into a query as text. `filterOperands` (below) reads the grammar into comparisons, so a backend only renders each one.
- **Deletes**: deleting a node removes every relationship touching it, as part of the same operation.
- **Transactions**: every operation is atomic. It joins the caller's transaction when one is open (`ctx`), and otherwise commits on its own — opening a transaction of its own only if it needs one, and never one that outlives the call.
- **Paging**: see below.
- **Traversal**: `spec` arrives validated — its hops chain from `from` to `to`, and a repeated hop (`both`, or `maxHops` > 1) joins one node type. Return the distinct end nodes; a repeated hop is bounded by its `maxHops` whatever cycles the data holds.
- **Creation**: the store runs `assertEndpointsListed` (exported by `@telorun/graph`) when it is created, the twin of `GRAPH_ENDPOINT_NOT_IN_STORE`.

## Paging — the envelope and the tail

A cursor has two owners, and a backend implements one half.

- **`graph` owns the envelope.** It is what the caller sees as `next` / `cursor`: an opaque text carrying a format version, a digest of what the listing was asked of (operation kind, the store's declared name, the type's declared name — for a traversal its declared path and start key — endpoint filters, canonical `where`) and the backend's tail. The binding holds declared names only, so a cursor is accepted by every replica and after a restart of the same application. Two stores that share a name in different modules and list same-named types share a binding: a cursor crossing them resumes at the wrong position and reads nothing the call could not. `graph` refuses a malformed envelope, an unknown version and a digest that does not match the call, all as `GRAPH_CURSOR_INVALID`, before the store is called.
- **The backend owns the tail.** `page` is `{ limit, after? }`. `limit` is always set (the operation's contract bounds and defaults it). `after`, when present, is a tail this store returned earlier, handed back verbatim; `graph` never reads it. A list result is `{ items, next? }`: at most `limit` items in the listing's order, strictly after `after`, and `next` — the tail to resume from — **only when more items exist**.

A tail is text and whatever the backend needs to resume: `graph-sql`'s is the last item's key (or source and target). It must not depend on `limit`, since a caller may change `limit` between pages. A tail the store does not accept is the outcome **`cursorInvalid`** — never a thrown code — which `graph` reports as `GRAPH_CURSOR_INVALID`.

### A tail of keys

Every listing is ordered by key, so "resume after the last key" is the ordering rule itself, and a backend ordered by key needs no tail format of its own. `@telorun/graph` exports the two halves:

| Export | What it does |
| --- | --- |
| `encodeKeyTail(keys)` | The key values of a page's last item — one for a node, source and target for a relationship — as tail text. |
| `decodeKeyTail(tail, arity)` | The key values a tail holds, or nothing when it is not a tail of `arity` values: not written by `encodeKeyTail`, another arity, or an encoding generation this runtime does not read. A backend answers nothing with `cursorInvalid`, before any statement. |

**A tail carries each key in the value domain's own one-to-one encoding** — the typed frame `@telorun/sdk` defines — so a key comes back as the value the operation returned it as: text as text, an integer as the same integer across the whole int64 range, a fraction, a non-finite number, a boolean, bytes, a list or a map alike. **A listing therefore resumes after any key an operation can return**, and the tail adds no loss of its own: it carries what was returned. A key that is not a value of the domain — a host object a driver handed back — is refused when the tail is written, by the frame's own error `ERR_TYPED_FRAME_UNENCODABLE`, which names the value; such a key was already not what the operation's contract declares. A backend that adds selectors of its own to a tail (a layered store names the draft or revision a listing was read at) keeps them beside this text and re-checks them itself.

The other export a backend reads its inputs with is **`filterOperands(describe, where)`**: every comparison a `where` holds as `{ operator, property, value }`, in operator order, with an operator the grammar does not have refused. What a comparison means against the backend's own storage — which column or attribute a property is, how an absent one is tested — stays the backend's.

### What a backend may do with a tail

The envelope's digest is not keyed and does not cover the tail, so a caller can hand a store any tail under a valid envelope. A cursor is a position, not a credential, and these rules are what keep it one:

1. A tail is untrusted input on every call.
2. Each field of it is either a value bound into an ordering comparison, or a selector the backend checks again against what this same call could read with no cursor.
3. A tail never becomes statement text, never names a table, a column or a limit, and never widens what the call could read.
4. A tail the backend cannot read as one it wrote — unreadable, the wrong shape, a value outside what its encoding holds, a selector that fails its re-check — is the outcome `cursorInvalid`, returned before any statement is issued. A tail it can read is still only a position: its values get what a `key` input gets. One the engine accepts yields a page of what the call could read with no cursor, wherever it points; one the engine refuses for the key's type fails the call as that value in `key` would.
5. A tail holds only values the caller was already given: keys it was returned, never an internal identifier.

`isGraphStore`, `isGraphNodeType` and `isGraphRelationshipType` are the guards the operations resolve their slots with; a backend's instances must satisfy them.

## Adding a listing operation over a store

A module that adds operations over a `Graph.Store` — a lifecycle listing, say — pages them through the same cursor, and never builds one of its own. `@telorun/graph` exports what that takes:

| Export | What it is for |
| --- | --- |
| `GraphListing` | One listing call. Built from the operation's description, its `limit` / `cursor` / optional `where` inputs, and a **subject**; it yields the `page` to hand the store and the canonical `where`, and its `result(outcome)` turns the store's outcome into `{ items, next? }` or raises `GRAPH_CURSOR_INVALID`. |
| `boundName(instance, describe, slot)` | The declared name a cursor is bound to. It is required: an instance with no declared name is refused. |
| `declaredName(instance)` | The declared name for a message. |
| `quoteKey(key)` | A key as a message quotes it. |
| `assertNodeListed`, `assertRelationshipListed` | The creation twins of `GRAPH_TYPE_NOT_IN_STORE`, for a kind that names a type and a store. |

The subject is what the cursor is bound to: the operation, the store's declared name, the type's, and whatever else selects the listing. **Name the operation qualified by your module** (`GraphLayers.ListDrafts`), so it never shares a binding with a `Graph.*` listing or with another module's. Names only, read through `boundName` — never a stamped identity, whose module component is a machine path.

The envelope itself — its encoding, its version, its digest, the canonical form of `where` — and the wording of `GRAPH_CURSOR_INVALID` are not exported: nothing outside `graph` builds an envelope or raises that code. A backend needs none of this; it implements the store interface and owns only its tail.

A store that is one layer of several implements this interface over its layered view and extends it with the layered contract — see [`graph-layers`](../../graph-layers/docs/store-contract.md).
