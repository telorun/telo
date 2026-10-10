---
description: "Implementing a layered graph strategy: the kinds a strategy module declares and the @telorun/graph-layers store interfaces — the layered one, and the drafted one with its session and cancellation contract."
sidebar_label: Layered store contract
---

# The layered store contract

`graph-layers` owns what a layer means and the lifecycle operations. A **strategy module** owns how layers are stored for one engine. This page is what a strategy implements; it extends [the graph store contract](../../graph/docs/store-contract.md), all of which still applies.

## The kinds a strategy declares

1. **A store kind** extending `GraphLayers.Store` (directly, or through a family's shared abstract such as `GraphLayersSql.CurrentStore`). It carries `layer:` and whatever says what the layer is built on and where it lives.
2. **Node and relationship kinds** extending `Graph.Node` / `Graph.Relationship`, each with a row projection, exactly as a plain backend declares them.
3. **Whatever storage the strategy needs, as declared resources.** A strategy issues no DDL and registers nothing at start-up: every table is a resource the application declares and lists in the engine's schema.

A strategy for a later level (drafted, revisioned) extends the store abstract of that level, which extends this one.

## The store interface — `@telorun/graph-layers`

A strategy's controller bundle imports the interface by the specifier `@telorun/graph-layers` (resolved through this module's `exports.code`, never inlined). The store instance implements `LayeredGraphStore`, which extends `@telorun/graph`'s `GraphStore`:

| Member | Returns |
| --- | --- |
| `layer` | the layer's name — the `origin` of everything the store itself states |
| `retractNode(type, key, ctx)` | `found` with the node now resolved, `absent` when nothing is beneath, or `notStated` |
| `retractRelationship(type, source, target, ctx)` | `found`, `absent`, or `notStated` |

What an implementation must hold to, beyond the graph contract:

- **Every `GraphStore` method answers over the layered view.** `getNode` returns the winning statement's value; `createNode` answers `exists` for a key that resolves from any layer; `deleteNode` hides what resolves from beneath; and so on, as [the operations page](graph-layers.md#operations-over-a-layer) states.
- **The view rule, decided at read.** A node resolves when the first statement for its key in the stack states a value. A relationship is in the view only while its first statement states a value **and both its endpoint nodes resolve in that same view**: `findRelationships` passes over any other, `traverse` neither ends on nor passes through a node the view lacks, and `updateRelationship` / `deleteRelationship` answer `absent` for it. A strategy whose gates make the rule hold for a given read may answer without checking; what is observed is the contract.
- **The stack.** The store's own layer, then each base in order followed by that base's stack; a layer reached more than once has one place, the lowest. A layer's identity is its name.
- **A node write states nothing about relationships.** `deleteNode` writes the node's removal (when a layer beneath still resolves the key) and withdraws the layer's own stated relationships touching it — never a removal for a relationship a layer beneath states.
- **Retract withdraws exactly one statement**, whatever the view, and answers with what the view then holds for the key.
- **`origin` on every value**: the name of the layer whose statement won.
- **Writes state only in the store's own layer.**
- **Outcomes, never codes** — `notStated` is an outcome; `graph-layers` maps it to `GRAPH_NODE_NOT_STATED` / `GRAPH_RELATIONSHIP_NOT_STATED`.
- **Atomicity**: every member is atomic, joining the caller's transaction when one is open and otherwise committing on its own. A delete that hides a node and withdraws the layer's own relationships to it is one operation.
- **Concurrent writes to one key through one layer each take effect in some order**: no write fails for having raced another write of the same key, and no write reports an outcome the layer does not then hold. A store retries nothing: writers meet at a conditional write the database decides, or at the layer's own row.
- **A read never writes.** A store that keeps a row per layer creates it with the layer's first write (opening a draft is one), in that write's own atomic operation. A read that finds a layer of its stack with no row yet treats it as holding nothing: the store's own layer reads as empty at revision 0, and a base contributes nothing. Nothing is remembered from such a partial resolution.
- **Paging**: the cursor tail follows the five tail rules of the graph contract. A selector a tail carries (a layer, a revision) is re-checked in code before any statement and answers `cursorInvalid`.

`isLayeredGraphStore` is the guard the retract kinds resolve their `store` slot with, exported together with `resolveLayeredStore` for a further level's lifecycle kinds. A drafted or revisioned interface extends `LayeredGraphStore` and adds its own guard; no member here changes meaning at a higher level.

## The drafted level — `DraftedGraphStore`

A strategy that keeps drafts implements `DraftedGraphStore`, which extends `LayeredGraphStore`; its store kind extends `GraphLayers.DraftedStore`. Every member above keeps its meaning, with one addition to how the store's operations are reached: **inside a draft session on the store they read and write that draft, and outside one they read the published state and write it in place.**

| Member | Returns |
| --- | --- |
| `openDraft(request, ctx)` | `found` with `{ draft: { id, parentRevision, createdAt }, opened }` |
| `openSession(entry, draft, cancellation, ctx)` | `opened`, `draftNotFound`, `draftClosed` or `draftForeign` |
| `closeSession(entry)` | `draftClosed` when the store itself ended the session, otherwise nothing |
| `publish(draft, request, ctx)` | `found` with `{ revision: { number, publishedAt }, changed }`, `draftNotFound`, `draftClosed` (discarded), `draftStale`, `draftConflicted` |
| `discardDraft(draft, request, ctx)` | `found`, `draftNotFound`, `draftClosed` (published) |
| `rebaseDraft(draft, ctx)` | `found` with `{ parentRevision, merged, conflicts }`, `draftNotFound`, `draftClosed` |
| `listDrafts(page, ctx)` | a page of drafts, or `cursorInvalid` |
| `nodeConflicts(type, page, ctx)`, `relationshipConflicts(…)` | a page of conflicts of the session's draft, or `cursorInvalid` |
| `resolveNodeConflict(type, key, decision, ctx)`, `resolveRelationshipConflict(…)` | `found` with the value now shown, `absent`, `conflictNotFound`, `resolutionInvalid` |

A draft's `id` is its public id; no internal id leaves the store. Revision numbers are `bigint`, instants `Date`.

### Sessions and cancellation

A session is a zone the `DraftSession` kind opens on its body, correlated on the store, and identified by the zone entry the kernel mints.

- `openSession` is called with that entry, the draft's public id and **the session's own cancellation source** — one `DraftSession` creates for the session and links to its caller's token. The store keeps what it knows about the session in a map of its own keyed on the entry; nothing store-private rides the entry.
- The store recognises a call made inside a session by the zones correlated on itself in the call's context (`ctx.zonesFor(store, invokeCtx)`), innermost first, looked up in that map.
- **Every session operation makes its draft-open check and its write one conditional write the database enforces** — no claim, lease or heartbeat. When an operation finds the draft no longer open, the store records how it was closed, **cancels the session's source**, and stops the operation as a cancellation (`ERR_INVOKE_CANCELLED`).
- The step engine never catches a cancellation of the invocation it runs, and the kernel refuses to dispatch under a cancelled token — so no `try:` in the body absorbs the end of the session and no later step runs.
- `closeSession` removes the store's record and returns how the store closed the session, if it did. `DraftSession` raises `GRAPH_DRAFT_CLOSED` only when the body failed with a cancellation, the store reports having closed the session, and the caller's own token is not cancelled; a cancellation from anywhere else passes through untouched.

### What a drafted store must hold to

- **The view rule and the stack**, inside a session and outside one. A base's draft is never visible above it.
- **Publish is conditional and atomic**: only on the revision the draft stands on, all of the draft at once, refused while a conflict is undecided or a relationship the layer states has an endpoint that does not resolve in the view being published. Publishing a published draft answers with its revision.
- **A revision number advances with every publish that changes the layer and every write outside a session that changes what the layer states**, in the same atomic operation as the write.
- **A write that changes nothing writes nothing.** A merge or update whose given values all equal the layer's own current statement for the key returns that value and leaves no trace: no revision, no advance of the counter, and inside a session no draft row. Equal means the same value of the same type, and the column's type is never consulted: both absent or null, the same text, the same boolean, the same number (an integer being one value whether held as a number or an int64), the same bytes, the same instant, lists the same element by element, maps the same key by key in any order. Text never equals a number or a boolean, so equality errs toward writing. The first write of a key the layer does not itself state is a change even when the values equal what a base states: the layer becomes the value's `origin` and stops following its base; that same write again is then no change. Inside a session, a write to a key with an undecided conflict is never a no-op: it settles the conflict.
- **`openDraft` is decided under the layer's row**, as a publish is, so it never falls between a draft closing and the next one opening: it answers with the open draft or a new one, and has no failure of its own.
- **The actor of what a store does on nobody's behalf** — a write outside a session, a publish, an open or a decision given no `actor` — is `storeActor(name)`, exported by `@telorun/graph-layers`: type `store`, and the store's declared name. Every strategy records that one value, so an audit row does not change with the alias an application imports a strategy under.
- **A decision is one conditional write**: of two callers deciding one conflict exactly one applies; the other is `conflictNotFound`.
- **`draftStale` means only that the layer's revision is not the draft's parent.** A base's write is never staleness; an endpoint it removes from under a relationship the layer states is `draftConflicted`, listed as `endpoint-missing`.
- **`endpoint-missing` covers what publishing would leave**: the draft's own stated relationships, and the layer's published relationships at a node the draft removes or retracts.
- **A token names the conflict in the state it was listed in**: it changes whenever either side is written again — for a published relationship the draft never touched, with that relationship's own revision — and a decision carrying a token that no longer matches is `conflictNotFound`.
- **Listings are paged by `graph`**: the lifecycle kinds reach `listDrafts` and the conflict listings through `GraphListing` of `@telorun/graph`, with their operation named `GraphLayers.<Kind>` in the subject. A store only reads and writes its tail.
- **Tails**: a tail issued inside a session carries the draft's public id and whatever identifies the state it was read from, both re-checked before any statement names a value of the tail — another draft, a closed one, the session boundary crossed either way, or a rebase since, is `cursorInvalid`. Only last-key values reach the engine, as bound values.

`isDraftedGraphStore` is the guard, and `resolveDraftedStore` resolves a drafting kind's `store` slot with it.

## The revisioned level — `RevisionedGraphStore`

A strategy that keeps every published revision implements `RevisionedGraphStore`, which extends `DraftedGraphStore`; its store kind extends `GraphLayers.RevisionedStore`. Every member above keeps its meaning and its outcomes, and the store passes the drafting suite unchanged. `rebaseDraft` gains two outcomes, `baseRevisionConflict` and `baseLimit`. It adds five members:

| Member | Returns |
| --- | --- |
| `listRevisions({ order, after?, layer? }, page, ctx)` | a page of `{ number, label?, message?, publishedAt, publishedBy, bases }` in `order`, those numbered above `after`, of `layer` or the store's own; or `cursorInvalid`, `layerNotFound` |
| `pinBases(bases, ctx)` | `found` with `{ bases, merged, conflicts }`; or `layerNotFound`, `revisionNotFound`, `baseCycle`, `baseRevisionConflict`, `baseLimit`, `draftConflicted` |
| `unpinBase(layer, ctx)` | `found` with `{ bases, merged, conflicts }`; or `baseNotPinned`, `draftConflicted` |
| `listBases(ctx)` | `found` with the direct pins, each `{ layer, revision, label?, position }` |
| `labelRevision({ revision, label, actor? }, ctx)` | `found` with `{ number, label }`; or `revisionNotFound`, `revisionLabelExists`, `revisionLabelled` |

`BASE_STACK_LIMIT` (32) and `isRevisionLabel` are exported beside them.

### What a revisioned store must hold to

- **A published revision never changes, and a revision is a change to what the layer states.** A publish, and each write outside a session that changes the layer's statement, makes one revision, numbered head + 1 by an increment the database applies in the same atomic operation; a row a revision replaces is kept. A write that changes nothing makes none, so a redelivered merge adds nothing to the change feed.
- **`openDraft` always opens a draft**, and any number are open on a layer.
- **A session reads the draft over the layer at the draft's parent revision**, whatever is published meanwhile; `rebaseDraft` is what moves it.
- **Rebase is three-way, per property**, against the layer's row the draft was written over: what one side alone changed merges, and a conflict's `properties` names only what clashed. A conflict that has an ancestor carries it as `base`.
- **A token is drawn from every row the conflict's class was decided from**, published-side rows included, and never exposes a row's identity.
- **A read outside a session stays on one revision.** The tail of a listing's first page carries the revision it was read at, and every later page reads that revision.
- **The layers beneath are pinned.** The stack is the layer, then each direct pin in position order followed by that pin's own base list at the pinned revision; one layer at two revisions anywhere in it is refused, as is the store's own layer beneath itself and a thirty-third layer — each judged at the pinned revisions, not at heads. A base list is part of a revision: a base publishing again changes nothing above, and a base's draft is never visible above it.
- **`pinBases` is one move**, and a move that changes nothing makes no revision. It, `unpinBase` and `listBases` follow the session; outside one a change is one published revision, refused as `draftConflicted` with nothing changed when it would leave a conflict or a relationship of the layer's with an unresolved endpoint.
- **A moved pin is merged like a moved layer.** Every statement the layer makes records the row beneath it; when the stack changes, each is compared three ways with what now lies beneath, by the same merge a rebase uses. A statement the layer had only published is a conflict too, listed and resolved through the draft. After the move, every statement that no longer stands on what lies beneath it is a listed conflict.
- **`rebaseDraft` re-applies the draft's own pin changes onto the head's base list**; where both changed one entry, the draft's stands, and a result that is no legal stack refuses the rebase with nothing changed.
- **A removal is a statement.** Deleting a key that resolves from beneath states a removal, which hides the key for every layer above; retract withdraws exactly one statement and answers what now resolves from beneath.
- **`origin` is a layer's name**, never a revision, for every layer of a stack.
- **A label is permanent and one per revision**, enforced by the database, so of two callers giving one label to two revisions exactly one is `found`.
- **Tails**: a revision in a tail is a selector, re-checked against the layer's head before any statement names a value of the tail — one the layer has not published is `cursorInvalid`. Every published revision of a layer is readable by whoever reads the layer, so a tail naming an earlier one widens nothing; it holds no row identity. A publish never invalidates a tail; a tail issued inside a session also identifies the draft's base list, so it is `cursorInvalid` once a pin of that draft moves.

`isRevisionedGraphStore` is the guard, and `resolveRevisionedStore` resolves the `store` slot of a history, pinning or labelling kind with it.

## Proving a strategy

`modules/graph-layers/tests/__fixtures__/layered-suite` is the behaviour suite every strategy runs: a library taking seven stores — `base`, `middle` on `base`, `side`, `top` on `middle` then `side`, and the diamond `left` on `base`, `right` on `base`, `apex` on `left` then `right` — and the `person` / `document` / `knows` / `authored` types as `resources:` inputs. A strategy's test imports it, supplies its own stores and tables, and lists the suite's sequences as targets — `defaults` last, since it adds documents the `paging` sequence would list. The `document` type's table declares a non-null text `status` defaulting to `draft` and an integer `pages` defaulting to 1, and the `authored` table an integer `share` defaulting to 100: `defaults` pins that a key the view does not show is written with them.

**One suite runs over all three levels.** It takes one more input, `refreshStacks`, a `Run.Sequence` it invokes after every step that writes a base another store then reads. A strategy that reads its bases live supplies a sequence that does nothing; a strategy that pins them supplies one that pins each store of the fixture stack to the head of each of its bases — which is why a pin move that changes nothing must cost nothing. What only a live stack can show — a base's write visible above with no step between — is `modules/graph-layers/tests/__fixtures__/live-stack-suite` (two stores, `top`'s stack reaching `base`; one sequence, `liveBases`), run by the current and drafts strategies alone. What only a pinned stack can show is `modules/graph-layers/tests/__fixtures__/stacking-suite`, taking seven revisioned stores of those names with the `person` and `knows` types, whose sequences (`pinning`, `removals`, `upgrade`, `pinnedLinks`, `cursors`, `labels`, `diamond`, `rebasedPins`) are listed as targets in that order over stores that start empty and unpinned.

A drafting strategy also runs `modules/graph-layers/tests/__fixtures__/drafting-suite`: a library taking two drafted stores — `base`, and `top` built on it — with the `person` and `knows` types, whose sequences (`isolation`, `stale`, `conflicts`, `automation`, `closedDraft`, `cursors`) are listed as targets in that order over stores that start empty. It assumes nothing about how a draft is stored, how many a layer may have open, or which changes a strategy merges by itself: every conflict in it is built from both sides writing the same property. Its two stores need not form a stack — nothing in it reads `base` through `top` — so a strategy that pins its bases supplies two unpinned layers.
