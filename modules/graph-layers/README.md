# Graph Layers

Several knowledge graphs kept as **named layers** in one database, where a layer can be built on one or many others — read live as they are now, or pinned to a revision or a label and upgraded by moving the pin. A layer reads as a whole graph — its own statements over everything the layers beneath it hold — and writes only to itself. Every `Graph` operation works over a layer unchanged; this module adds the layered store contract and the two operations that withdraw a layer's own statement. A relationship is in a layer's view only while both the nodes it joins are, so a node hidden or deleted anywhere in the stack takes its relationships out of the view without anything being deleted for them.

`graph-layers` names no engine and no versioning strategy. How layers are stored — and whether they are versioned — is a **strategy module**, one per engine.

## The three levels

The layered contract has three levels, each a strategy module family:

| Level | What a layer holds | Status |
| --- | --- | --- |
| **Current** — `GraphLayers.Store` | Only its current statements. Every write takes effect at once. | This module, with [`graph-layers-current-sqlite`](../graph-layers-current-sqlite/README.md) and [`graph-layers-current-postgres`](../graph-layers-current-postgres/README.md). |
| **Drafted** — `GraphLayers.DraftedStore` | Its published statements plus a draft, published atomically as a numbered revision. | This module, with [`graph-layers-drafts-sqlite`](../graph-layers-drafts-sqlite/README.md) and [`graph-layers-drafts-postgres`](../graph-layers-drafts-postgres/README.md). |
| **Revisioned** — `GraphLayers.RevisionedStore` | Every revision it ever published; drafts are parallel and each reads the layer as it stood when the draft began; the layers beneath are pinned at a revision or a label. | This module, with [`graph-layers-revisions-sqlite`](../graph-layers-revisions-sqlite/README.md) and [`graph-layers-revisions-postgres`](../graph-layers-revisions-postgres/README.md). |

Each level extends the one beneath, so what is written against `GraphLayers.Store` keeps working over a drafted or revisioned store. Every lifecycle kind is declared once, here, and its `store` slot names the lowest level at which it works: a drafting kind over a current store, or a pinning, labelling or history kind over a store that keeps no history, is refused by `telo check`.

## Live stacks and pinned stacks

On the current and drafted levels a stack is **declared and read live**: the store's `bases:` lists the stores it is built on, and a change to a base shows above it on the next read.

On the revisioned level a stack is **data**: `PinBase` builds the layer on a revision — a number, a label, or the newest — of each layer beneath, and what a base publishes afterwards changes nothing above until the pin is moved. An upgrade is a pin move: what the base changed is merged per property into what the layer states over it, what collides is listed in five conflict classes that block publishing, and deciding them is ordinary steps. A diamond is upgraded by moving both sides in one call. `LabelRevision` gives a revision a permanent name to pin by.

Whatever the level, a layered table has no foreign key: a relationship is in a view only while both the nodes it joins resolve there.

## Limits

- Every layer of a stack lives in the application's own database, and gets there by that application writing it.
- Retained history is unbounded; there is no compaction.
- A pinned stack holds at most 32 layers.
- A pin move costs the size of the layer being re-pinned.
- Each type is one table, and published reads come from the store that is authored in.
- A reader of one layer can list any layer's revisions in the same tables.

Not built yet: releases shipped inside a library, diff / history / restore, a published copy in separate storage, split table layouts and compaction. See [Revisions](docs/revisions.md#limits).

## Runtime

This module requires telo **0.108.0 or newer** (`requires: telo: ">=0.108.0"`). Every strategy module imports it, so that is the floor of a layered graph of **any** strategy — the current one included — whatever lower floor a strategy module declares for its own file. The floor is the module's as a whole: an instant is returned as a native timestamp, and one bundle carries every kind.

## What the current strategy cannot do

- **No history.** A layer holds what it states now; an overwritten or deleted value is gone.
- **No drafts.** A write is visible to every reader of the layer, and of every layer built on it, as soon as it commits.
- **No pinned view.** A layer reads its bases as they are at that moment: a change to a base shows above it on the next read, and nothing lets a layer keep reading an earlier state of a base.
- **No single-moment listing.** A paged listing reads each page against the graph as it then is (see [Paging](docs/graph-layers.md#paging)).

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `GraphLayers.Store` | Provider (abstract) | A graph store that is one named layer: `layer:` plus what `Graph.Store` declares. |
| `GraphLayers.RetractNode` | Invocable | Withdraw the layer's own statement for a key, so the layer beneath shows again; `GRAPH_NODE_NOT_STATED`. |
| `GraphLayers.RetractRelationship` | Invocable | The same for a relationship; `GRAPH_RELATIONSHIP_NOT_STATED`. |
| `GraphLayers.DraftedStore` | Provider (abstract) | A layer edited in drafts and published atomically. Extends `Store`. |
| `GraphLayers.OpenDraft` | Invocable | Open a draft on a layer, or return the open one. |
| `GraphLayers.DraftSession` | Invocable | Run a body of steps in which the store's operations read and write one draft; `GRAPH_DRAFT_CLOSED` when the draft is closed under it. |
| `GraphLayers.Publish` | Invocable | Publish a draft as the layer's next revision; `GRAPH_DRAFT_STALE`, `GRAPH_DRAFT_CONFLICTED`. |
| `GraphLayers.DiscardDraft` | Invocable | Drop a draft and what it staged. |
| `GraphLayers.RebaseDraft` | Invocable | Move a draft onto the current revision, merging what agrees and leaving conflicts. |
| `GraphLayers.ListDrafts` | Invocable | List a layer's open drafts, with whether each is stale. |
| `GraphLayers.NodeConflicts`, `GraphLayers.RelationshipConflicts` | Invocable | List a draft's undecided conflicts, inside a session. |
| `GraphLayers.ResolveNodeConflict`, `GraphLayers.ResolveRelationshipConflict` | Invocable | Decide one conflict by side, optionally with values set on top. |
| `GraphLayers.RevisionedStore` | Provider (abstract) | A layer that keeps every published revision and is built on pinned revisions of others. Extends `DraftedStore`. |
| `GraphLayers.ListRevisions` | Invocable | List a layer's published revisions — its own or any layer's in the same tables — newest or oldest first, optionally after a number, each with its label and pins: the layer's change feed. `GRAPH_LAYER_NOT_FOUND`. |
| `GraphLayers.PinBase` | Invocable | Build a layer on revisions of others, or upgrade it, several pins as one move; `GRAPH_LAYER_NOT_FOUND`, `GRAPH_REVISION_NOT_FOUND`, `GRAPH_BASE_CYCLE`, `GRAPH_BASE_REVISION_CONFLICT`, `GRAPH_BASE_LIMIT`, `GRAPH_DRAFT_CONFLICTED`. |
| `GraphLayers.UnpinBase` | Invocable | Remove one direct pin; `GRAPH_BASE_NOT_PINNED`, `GRAPH_DRAFT_CONFLICTED`. |
| `GraphLayers.ListBases` | Invocable | List a layer's direct pins, each with its revision and label. |
| `GraphLayers.LabelRevision` | Invocable | Give a published revision a permanent label; `GRAPH_REVISION_NOT_FOUND`, `GRAPH_REVISION_LABEL_EXISTS`, `GRAPH_REVISION_LABELLED`. |

`GraphLayers.Actor` is the `{ type, id }` shape the drafting operations record who acted with, and `GraphLayers.PinnedBase` the `{ layer, revision, label?, position }` shape every base list is returned in.

## Example

Two layers over the same SQLite tables — `team` built on `shared` (kinds from [`graph-layers-current-sqlite`](../graph-layers-current-sqlite/README.md), imported as `Layers`):

```yaml
kind: Layers.Store
metadata: { name: shared }
connection: !ref db
schema: !ref appSchema
layer: shared
nodes: [!ref person]
---
kind: Layers.Store
metadata: { name: team }
connection: !ref db
schema: !ref appSchema
layer: team
bases: [!ref shared]
nodes: [!ref person]
---
kind: Graph.GetNode
metadata: { name: getPerson }
store: !ref team
node: !ref person
---
kind: GraphLayers.RetractNode
metadata: { name: revertPerson }
store: !ref team
node: !ref person
```

`getPerson` answers `{ node: { key, properties, origin } }` — `origin` is `team` when the team layer states the person, `shared` when it shows through. `revertPerson` withdraws whatever `team` says about a key and returns the node `shared` holds, if any.

## Docs

- [Layers, precedence, writes, hiding and retraction](docs/graph-layers.md)
- [Drafting — sessions, publish, rebase, conflicts and resolving them](docs/drafting.md)
- [Revisions — retained history, pinned stacks, upgrades, labels, three-way merge and the change feed](docs/revisions.md)
- [The layered store contract — implementing a strategy](docs/store-contract.md)
