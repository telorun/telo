---
description: "Graph layers: named layers of a knowledge graph built on one another, overlay by precedence, writes that state only in the store's own layer, hiding, retraction, and what the current strategy guarantees."
sidebar_label: Graph layers
---

# `GraphLayers`

> Examples assume this module is imported under alias `GraphLayers`, `graph` under `Graph`, and a strategy module under `Layers`.

## The three levels

A layered graph is declared with a **strategy module** — a module per engine that ships the kinds its storage is declared with. The contract has three levels, each extending the one beneath:

1. **Current** (`GraphLayers.Store`): each layer holds only its current statements; a write is immediate. `graph-layers-current-sqlite` and `graph-layers-current-postgres` are this level.
2. **Drafted** (`GraphLayers.DraftedStore`): a layer is edited in a draft and published atomically as a numbered revision. `graph-layers-drafts-sqlite` and `graph-layers-drafts-postgres` are this level; see [Drafting](drafting.md).
3. **Revisioned** (`GraphLayers.RevisionedStore`): a layer keeps every revision it publishes, drafts are parallel and a stale one is merged per property. The layers beneath are pinned, each at one revision, and taking a base's changes is a pin move. `graph-layers-revisions-sqlite` and `graph-layers-revisions-postgres` are this level; see [Revisions](revisions.md).

What follows is the base level — what every strategy shares. Every lifecycle kind names the level its `store` needs: the retract kinds below take any `GraphLayers.Store`, the drafting kinds a `GraphLayers.DraftedStore`, the history listing and the pinning and labelling kinds a `GraphLayers.RevisionedStore`.

### What the current strategy cannot do

It keeps no history, has no drafts, and cannot pin a base: a layer always reads its bases as they are now. A listing read over several pages is not a single-moment view. If you need any of those, you need a drafted or revisioned strategy.

## Layers and precedence

A **layer** is a named graph. A store is one layer: `layer:` names it, and what it is built on is its base list, highest precedence first. On the current and drafted levels that list is **declared** — `bases:` on the strategy's store kind — and read live. On the revisioned level it is **pinned** — set by `PinBase`, each base at one revision — and the order below is the same with each base read as its pinned revision left it ([Revisions](revisions.md#pinned-stacks)).

A store's stack is its own layer, then each base in order followed by that base's stack. A layer reached more than once — two bases built on the same layer — has one place, the lowest of them, so every layer outranks the layers it is built on.

With `top` built on `[middle, side]` and `middle` on `[base]`, `top` resolves **top, middle, base, side**. With `apex` built on `[left, right]` and both of those on `[base]`, `apex` resolves **apex, left, right, base**: `right` overrides `base` in every stack that holds both.

A node is in a store's view when the first statement for its key in that order states a value. **A relationship is in the view when the first statement for its pair states a value and both its endpoint nodes are in the view.** Every strategy decides this when it reads.

For each key — a node's key, or a relationship's source and target — **the first statement in that order wins**:

- a winning statement that states a value makes that value the node or relationship;
- a winning statement that is a **removal** makes the key absent, whatever lies beneath.

Every value a layered store returns carries **`origin`**: the name of the layer whose statement won. A `where` filter judges the winner only — a row that matches the filter but is shadowed by a higher layer's statement never answers for the key.

On the current and drafted levels layers are read as they are now: a write to a base is visible above it on the next read. On the revisioned level a write to a base is visible above only once the pin is moved to its revision. Two stores over the same tables on different layers see only their own content unless one is built on the other.

## Operations over a layer

All twelve `Graph` operations work over a layered store unchanged, with the same inputs, outputs and codes. What changes is what "exists" means — it means *resolves in this store's view*:

| Operation | Over a layer |
| --- | --- |
| `GetNode`, `FindNodes`, `FindRelationships`, `Traverse` | Read the resolved view; every value carries `origin`. A relationship whose endpoint does not resolve is passed over, as a row a `where` rejects is, and a traversal neither ends on nor passes through a node the view lacks. |
| `CreateNode`, `CreateRelationship` | Refuse a key that resolves from **any** layer (`GRAPH_NODE_EXISTS` / `GRAPH_RELATIONSHIP_EXISTS`). A key this or another layer hides is absent, so it can be created. |
| `MergeNode`, `UpdateNode`, `MergeRelationship`, `UpdateRelationship` | A value this layer states is changed in place. A value from beneath is **copied whole into this layer**, and the change applied to the copy; the layer beneath is untouched. |
| `DeleteNode`, `DeleteRelationship` | A key that resolves from beneath is **hidden** by a removal in this layer; a key only this layer states has its statement removed. The output is the last resolved state. |
| `UpdateRelationship`, `DeleteRelationship` on a relationship out of the view | Answer as for an absent one (`GRAPH_RELATIONSHIP_NOT_FOUND`), whether a removal hides it or an endpoint does not resolve. |

**A write only ever states in the store's own layer.** Nothing a store does changes a layer beneath it.

**A relationship is in a view only while both its endpoints are.** Endpoints are keys resolved in the view: a layer may link its node to a node any layer beneath states, there is no foreign key, and the store checks both endpoints when a relationship is created or merged. When an endpoint stops resolving — a base deletes the node, or a layer above hides it — the relationship leaves that view with it: no listing returns it and no traversal reaches or passes through the missing node. Nothing is deleted for it. When the node resolves again, the relationship is back.

**Deleting a node** makes the key absent and withdraws this layer's own relationships touching it, in the same atomic operation. It states nothing about relationships the layers beneath hold; they are out of the view because the node is.

**Retracting withdraws exactly one statement.** Retracting a node's removal shows the node beneath again, together with every relationship the layers beneath state for it. Relationships this layer had stated for the node were withdrawn when it was deleted and are not restored. A relationship this layer states to a node that no longer resolves stays stated and out of the view; `RetractRelationship` withdraws it.

The endpoint check at create and merge answers `GRAPH_NODE_NOT_FOUND` (with `data.endpoint` on a create). A layer cannot link to a node only a layer *above* it states — it cannot see it. The same key is the same node in every layer: a key deleted and then stated again, by any layer of the stack, has every relationship the stack states for it. A store with no bases therefore behaves as a plain graph — its delete withdrew its own relationships, so a node created again has none.

This is the reverse of a plain `graph-sql` graph, where the database's cascading foreign keys remove a deleted node's relationships — a layered table has none, and nothing is cascaded.

Every operation is atomic: it joins the caller's transaction when one is open on the store's connection, and otherwise commits on its own. Concurrent writes to one key through one layer each take effect in some order: no write fails for having raced another write of the same key, and none reports an outcome the layer does not then hold.

**A read never writes.** Reading through a store changes nothing in the database, whatever the strategy, so a store used only to read works under a role that cannot write. A layer nothing has written yet reads as empty.

## Retraction

Deleting hides; **retracting withdraws**. `GraphLayers.RetractNode` and `GraphLayers.RetractRelationship` remove this layer's own statement for a key — a stated value or a removal — so whatever lies beneath shows again.

| Operation | Config | Inputs | Output | Throws |
| --- | --- | --- | --- | --- |
| `RetractNode` | `store`, `node` | `key` | `{ node? }` | `GRAPH_NODE_NOT_STATED` |
| `RetractRelationship` | `store`, `relationship` | `source`, `target` | `{ relationship? }` | `GRAPH_RELATIONSHIP_NOT_STATED` |

The output is the value now resolved for the key, with its `origin`; it is absent when no layer beneath holds the key. The `…_NOT_STATED` codes mean this layer said nothing about the key in the first place.

`store:` takes a `GraphLayers.Store`, so a plain `Graph.Store` is refused by `telo check`. A removal this layer stated for a relationship is a statement of its own: no node operation touches it, and it stays until it is retracted itself. `RetractRelationship` on a relationship that is out of the view only because its node is hidden is `GRAPH_RELATIONSHIP_NOT_STATED` — this layer states nothing for it.

```yaml
kind: GraphLayers.RetractNode
metadata: { name: revertPerson }
store: !ref team
node: !ref person
```

## Paging

`FindNodes`, `FindRelationships` and `Traverse` page by cursor exactly as in [`graph`](../../graph/docs/graph.md#paging), over the resolved view: following `next` to the end returns every visible key once, in order, whichever layers state, restate or hide it.

A current store has no revision to pin, so a listing is not a single-moment view. What holds: no key is returned twice, and every key that was visible for the whole listing is returned exactly once. A key stated, restated, hidden or retracted — in this layer or any beneath — while the listing is in progress is returned if it is visible and sorts after the cursor when its page is read.

A cursor is bound to the store it was issued through, so a cursor from one layer is `GRAPH_CURSOR_INVALID` through another.

### What a page costs

- **`FindNodes`** — in proportion to `limit` × the stack's depth: each layer contributes its own first `limit` visible winners. Never in proportion to the size of the table or to the pages already read.
- **`FindRelationships`** — in proportion to `limit` and to the square of the stack's depth: the same, and each relationship's two endpoints are resolved in the stack. Never in proportion to the size of the tables or to the pages already read. Relationships whose endpoints do not resolve are passed over as rows a `where` rejects are.
- **`Traverse`** — at most one walk of the traversal's reach per page, each hop reading only the relationships of the keys reached and resolving each reached node once; no page costs more than the first.

Precedence is decided by probing the layers above a row, never by resolving the whole stack before a page or a hop.

## Rules

| Code | Declared on | Refuses |
| --- | --- | --- |
| `GRAPH_TYPE_NOT_IN_STORE` | `RetractNode`, `RetractRelationship` | a node or relationship type the store does not list |

Reported by `telo check` (`RESOURCE_RULE_VIOLATED`, the code in `data.rule`) and refused again, under the same code, when the resource is created. The rules `graph` declares hold over a layered store too — a store listing a relationship type whose endpoint node type it does not list is `GRAPH_ENDPOINT_NOT_IN_STORE`. A strategy's storage rules are in its own docs ([`graph-layers-sql`](../../graph-layers-sql/docs/layered-sql.md) for the SQL family).
