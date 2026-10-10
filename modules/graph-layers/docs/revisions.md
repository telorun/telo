---
description: "Revisioned graph layers: every published revision retained, layers pinned to revisions or labels of the layers beneath, upgrades as pin moves merged per property, parallel drafts isolated at their parent revision, permanent revision labels, reads that stay on one revision, and ListRevisions as a change feed."
sidebar_label: Revisions
---

# Revisions

> Examples assume this module is imported under alias `GraphLayers`, `graph` under `Graph`, and a revisions strategy module under `Layers`.

Revisions is the third level of the layered contract. A store of that level extends `GraphLayers.RevisionedStore`: **every revision the layer published is kept**. Everything on [the drafted level](drafting.md) still holds — the same drafting kinds, the same codes, the same session — and a store of this level passes the drafting behaviour suite unchanged. This page is what it adds.

A revisioned layer is built on other layers by **pinning** them: its stack is data, not a declaration. A store of this level has no `bases:` — `PinBase` says which revision of which layer lies beneath, and nothing a base publishes afterwards shows above until the pin is moved.

## What a revisioned store adds

| | Drafted store | Revisioned store |
| --- | --- | --- |
| What a layer keeps | its published state, and one draft | every published revision, and any number of drafts |
| A write outside a draft | changes the published state in place | is a revision of its own when it changes what the layer states; what it replaces is kept |
| `OpenDraft` | returns the open draft (`opened: false`) when there is one | always opens another (`opened: true`) |
| A session reads | its draft over the layer as published **now** | its draft over the layer **at the draft's parent revision** — unchanged by what siblings publish, until rebased |
| Rebase compares | the draft with the published row (two-way) | each side with the row the draft was written over (three-way, per property) |
| A listed conflict | has no `base` | carries `base`, the ancestor |
| A paged read outside a session | reads each page against the layer as it then is | stays on the revision its first page was read at |
| The layers beneath | declared in `bases:`, read as they are now | pinned by `PinBase`, each at one revision, read as that revision left them |
| Taking a base's changes | happens by itself, on the next read | is a pin move: merged per property, with conflicts to decide |
| History | none | `ListRevisions`, and permanent labels through `LabelRevision` |

Retained history is **unbounded**: nothing removes an old revision, and there is no compaction yet. A key rewritten a thousand times holds a thousand rows.

## Revisions and drafts

A **revision** is a change to what the layer states. Every publish, and every write made outside a draft that changes the layer's statement, is one: numbered from 1 with no gap, immutable once published, and recorded with who published it and when by the database's clock. A merge or update whose values all equal what the layer itself already states writes nothing — no revision, no row, no entry in the change feed — so delivering a write twice costs nothing. Equal means the same value of the same type: the text `"7"` is not the integer `7`. A key the layer does not itself state is a change even when the values equal what a base states: the layer becomes its `origin` and the row stops following the base, which is one revision; the same write again is none. To leave a node following its base, do not write it. Concurrent writers get consecutive numbers — the number is allocated by an increment the database applies, with no retry and no refusal.

A **draft** is opened on the layer's head revision, its *parent*. Any number are open at once, and each is isolated: a session on one sees nothing of another, and keeps reading the layer at its parent revision while siblings publish. `Publish` succeeds only while the layer's head is still the draft's parent; otherwise it is `GRAPH_DRAFT_STALE`, and `RebaseDraft` moves the draft onto the head. So of two drafts opened on one revision, the first to publish becomes the next revision, and the second is stale, rebases, and conflicts only on the keys both changed.

A draft with no change publishes no revision (`changed: false`).

## Three-way merge

Rebasing compares, for each key the draft touched and the layer has since moved under, three rows: the draft's (`mine`), the layer's as it now stands (`theirs`), and the layer's row the draft was written over (`base`), which a revisioned store still holds.

- A property **only one side changed** takes that side's value. Two sides changing different properties of one key merge with no conflict.
- A property **both changed to the same value** is merged; so is a key both added with equal properties, or both removed.
- A property **both changed to different values** is a `changed-both` conflict, and `properties` names exactly those. The other properties are already settled: whichever side is taken, a property one side alone changed keeps that side's value.
- The other four classes are as on the drafted level.

`take: mine` keeps the draft's values for the properties that clashed, `take: theirs` the layer's; `set` applies on top of either. Taking `theirs` leaves no statement in the draft when the result is exactly what the layer publishes. An ordinary write to the key inside the session settles the conflict too, keeping the caller's version.

A conflict's `token` is drawn from every row its class was decided from — the draft's, the ancestor, the layer's, and for a missing endpoint the endpoint nodes' — so a token read before any of them was written again is `GRAPH_CONFLICT_NOT_FOUND`.

## Pinned stacks

A layer's **base list** is its direct pins in position order, each a layer at one of its revisions. Its stack is the layer itself, then each pinned base in that order followed by that base's own base list *at the pinned revision*, and so on down. A layer reached more than once has one place, the lowest, exactly as on the other levels — a diamond is legal.

The base list is part of a revision. Every revision of a layer has one, a draft starts with its parent's, and a session reads its draft over the layer at the draft's parent revision over the draft's pins. A base's draft is never visible above it, and a base publishing again changes nothing above.

```yaml
kind: GraphLayers.PinBase
metadata: { name: buildOn }
store: !ref team
```

```yaml
- name: pin
  invoke: !ref buildOn
  inputs:
    bases:
      - { layer: shared, revision: "2026.10" }   # a label
      - { layer: glossary }                      # its newest revision, now
```

| `bases[]` | |
| --- | --- |
| `layer` | The name of a layer registered in the same tables. A layer is registered by its first write, an opened draft, or a pin move that changes its base list. Reading through a store registers nothing, and neither does a call that is refused or changes nothing. |
| `revision` | An integer is a revision number, a string a label, omitted the base's newest revision at the call. Only the number is stored. `0` — a registered layer before its first revision — is a legal pin. |
| `position` | The pin's place among the direct bases, from 0. Omitted, a layer already pinned keeps its place and a new one is appended. |

The list is applied **as one move**, which is what lets a diamond be upgraded: with `apex` on `left` and `right`, both built on `base`, moving `left` alone to a revision built on a newer `base` would put `base` in the stack at two revisions; naming `left` and `right` in one call does not.

`PinBase` answers `{ bases, merged, conflicts }`: the direct pins after the move — each `{ layer, revision, label?, position }` — how many of the layer's statements merged with a change beneath them, and how many conflicts were left. **A call that changes nothing makes no revision** and answers the current list with both counts zero, so re-pinning to a head that has not moved costs nothing.

`UnpinBase` (`layer`) removes one direct pin and answers the same shape. `ListBases` returns the direct pins, whole — a stack is bounded.

All three **follow the session**. Inside a `DraftSession` on the store they act on the draft, and the move is published with it; a draft that only moved a pin publishes a revision. Outside one, a change is one published revision made by the store itself (`{ type: store, id: <the store's declared name> }`).

| Code | Raised by | Means |
| --- | --- | --- |
| `GRAPH_LAYER_NOT_FOUND` | `PinBase`, `ListRevisions` | No layer of that name is registered: nothing has written it yet. |
| `GRAPH_REVISION_NOT_FOUND` | `PinBase`, `LabelRevision` | The layer has no revision of that number or label. |
| `GRAPH_BASE_CYCLE` | `PinBase` | The store's own layer would lie beneath itself. |
| `GRAPH_BASE_REVISION_CONFLICT` | `PinBase`, `RebaseDraft` | The stack would hold one layer at two revisions, or the call names one layer twice. `data: { layer, revisions }`. |
| `GRAPH_BASE_LIMIT` | `PinBase`, `RebaseDraft` | The stack would hold more than **32** layers, the store's own included. |
| `GRAPH_BASE_NOT_PINNED` | `UnpinBase` | The layer is not among the direct pins. |
| `GRAPH_DRAFT_CONFLICTED` | `PinBase`, `UnpinBase` | Outside a session only: the move would leave a conflict, so nothing changed. |

Cycles and revision conflicts are judged on the stack at the pinned revisions, not on heads: pinning an older revision of a layer that later came to depend on this one is legal.

`origin` on a returned value is the **name** of the layer whose statement won, pinned or not, direct or transitive. It never carries a revision: `ListBases` gives a direct pin's, and `ListRevisions` with `layer` a transitive one.

## Upgrading is a pin move

Taking a newer revision of a base is `PinBase` to that revision. Every statement the layer itself makes — an override, a removal, a relationship — records the row beneath it that it was written over. When a pin moves, each of those statements is compared with what now lies beneath it, three ways, by the same merge a rebase uses: the statement is `mine`, the row now beneath is `theirs`, and the row it recorded is `base`.

- What the base alone changed merges into the layer's statement; what both changed alike merges; a statement that now says exactly what lies beneath it is withdrawn, as is a removal of a key the base no longer states.
- What both changed differently is a conflict, in the same five classes as on [the drafted level](drafting.md#rebase-and-conflicts), `changed-both` naming only the properties that clash. `endpoint-missing` is a relationship the layer states whose endpoint node no longer resolves under the new stack.

**A statement the layer had only published conflicts too** — that is the main case, since a draft opened to upgrade a base has no rows of its own. The move copies such a statement into the draft, so `NodeConflicts` / `RelationshipConflicts` list it and `ResolveNodeConflict` / `ResolveRelationshipConflict` decide it like any other conflict. `Publish` is refused `GRAPH_DRAFT_CONFLICTED` until none is left.

So an upgrade is: open a draft, `PinBase` inside a session on it, list and resolve what it left, publish.

```yaml
- name: draft
  invoke: !ref openTeamDraft
  inputs: { message: "take shared 2026.10" }
- name: upgrade
  inputs: { draft: !cel "steps.draft.result.draft.id" }
  invoke:
    kind: GraphLayers.DraftSession
    store: !ref team
    inputs: { draft: !cel "inputs.draft" }
    steps:
      - name: pin
        invoke: !ref buildOn
        inputs: { bases: [{ layer: shared, revision: "2026.10" }] }
      # list conflicts, decide each, as in Drafting
- name: publish
  invoke: !ref publishTeam
  inputs: { draft: !cel "steps.draft.result.draft.id" }
```

**Outside a session** the same move runs as one revision and is all-or-nothing: if it would leave any conflict, or a relationship of the layer's with an unresolved endpoint, it is `GRAPH_DRAFT_CONFLICTED` and the base list, the head and every read are unchanged. A revisioned layer therefore never publishes a dangling relationship of its own. A relationship a *base* states whose endpoint another base dropped is nobody's conflict — it is out of the view at read.

**What a pin move costs**: in proportion to the number of statements the layer being re-pinned makes, one probe of each layer of the new stack for each — never to the size of any base or to retained history. Outside a session the layer is held for that walk, so **a large layer moves a pin inside a draft**, where only the publish holds it.

**`RebaseDraft` and pins.** Rebasing a draft re-applies the draft's own pin, unpin and position changes onto the head's base list: a sibling's move of another base is kept alongside the draft's, and where both moved one base the draft's entry stands. When the result is not a legal stack the rebase is refused and changes nothing — `GRAPH_BASE_REVISION_CONFLICT` or `GRAPH_BASE_LIMIT` — and the caller re-pins in the session and rebases again.

## Hiding and retracting over a pinned stack

Deleting a key that resolves from beneath writes a **removal**: a statement of the layer's own that hides the key, for this layer and every layer built on it. Deleting a key only this layer states withdraws the statement and leaves nothing. A hidden key is absent, so it can be created again.

`RetractNode` / `RetractRelationship` withdraw exactly the layer's one statement for the key — a value or a removal — and answer the value now resolved from beneath; `GRAPH_NODE_NOT_STATED` / `GRAPH_RELATIONSHIP_NOT_STATED` when the layer holds neither.

## Labels

```yaml
kind: GraphLayers.LabelRevision
metadata: { name: tagShared }
store: !ref shared
```

`LabelRevision` (`revision`, `label`, optional `actor`) gives a published revision of the store's own layer a second name that other layers can pin. A label is 1 to 128 letters, digits, `.`, `_`, `+` or `-`, at least one of them not a digit — so it is never read as a revision number.

**Labels are permanent, one per revision.** A label is never moved or removed, and a revision carries at most one. Labelling the same revision with the same label again changes nothing and succeeds; the label on another revision is `GRAPH_REVISION_LABEL_EXISTS` (`data: { label, revision }`), and another label on the same revision is `GRAPH_REVISION_LABELLED`. Of two callers giving one label to two revisions at once, exactly one succeeds. It acts the same inside a session as outside: a label names a published revision.

## Reading one revision

A read outside a session reads the layer's head. A paged listing — `FindNodes`, `FindRelationships`, `Traverse` — **stays on the revision of its first page**: its cursor carries that revision, so paging across other callers' publishes returns no key twice, misses none the revision held, and shows each as that revision had it. A new listing starts at the head again.

A revision's pins are part of it, so a listing that stays on a revision stays on that revision's whole stack: **a publish never invalidates a cursor** — not the layer's own, not a base's, not a pin moved outside a session.

Inside a session a cursor carries the draft, its parent revision and its base list. A cursor is `GRAPH_CURSOR_INVALID` when used across the session boundary in either direction, in a session on another draft, after `RebaseDraft` moved the draft, after a pin of that draft moved, or when it names a revision the layer has not published.

A page costs what it costs on the other levels — `limit` × depth for nodes, that times twice the depth again for relationships, one walk of its reach for a traversal — whatever the size of the tables, however far the cursor has come, and however many revisions a base has published since it was pinned. A page that crosses a key rewritten many times reads its versions.

## The change feed — `ListRevisions`

```yaml
kind: GraphLayers.ListRevisions
metadata: { name: teamHistory }
store: !ref team
```

| Input | |
| --- | --- |
| `order` | `descending` (default) lists the newest first; `ascending` the oldest. |
| `after` | A revision number: only revisions after it are listed. |
| `layer` | The layer to list: any layer registered in the same tables — which is how a revision or a label is chosen before it is pinned. Omitted, the store's own. `GRAPH_LAYER_NOT_FOUND` for an unknown name. |
| `limit`, `cursor` | Paging, as on every listing. `GRAPH_CURSOR_INVALID` for a cursor of another listing — another store, another `layer`, another `order`, another `after`. |

It returns `revisions[] { number, label?, message?, publishedAt, publishedBy, bases[] }` and `next` when more exist. `bases` is that revision's direct pins, in the shape `ListBases` returns. `publishedBy` is the actor `Publish` was given, or the store itself — `{ type: store, id: <the store's declared name> }` — for a publish given none and for a write or a pin move made outside a draft. It does not follow the session: it lists published revisions.

**To follow a layer**, keep the last number you hold and ask for what came after it:

```yaml
- name: news
  invoke: !ref teamHistory
  inputs: { order: ascending, after: !cel "inputs.lastSeen" }
```

Numbers are consecutive, so a gap is visible by number: a consumer holding revision 41 that is answered 43 first has missed one. Never detect a gap by time — two revisions can share an instant, and clocks are not ordered across writers.

`ListRevisions`, `PinBase`, `UnpinBase`, `ListBases` and `LabelRevision` over a store that keeps no history — a current or a drafts store — are each a `REFERENCE_KIND_MISMATCH` at `telo check`.

## Limits

- **Every layer of a stack lives in the application's own database**, in the same tables, and gets there by that application writing it. Nothing ships a layer or loads one from elsewhere.
- **Retained history is unbounded.** Nothing compacts it, and nothing yet refuses to.
- **A stack holds at most 32 layers**, the store's own included.
- **A pin move costs the size of the layer being re-pinned**, whatever changed beneath.
- **Each type is one table**, shared by every layer.
- **Published reads come from the authoring store**: there is no separate published copy.
- **A reader of one layer can list any layer's revisions** in the same tables; layers are not access boundaries.

Not built yet, and what a later release adds: releases — a root layer shipped inside a library and loaded once per label; diff, history and restore of a key; a published copy in separate storage; split table layouts; compaction, and with it a refusal to drop a pinned revision; and a pin move costed by what changed beneath rather than by the layer's size.
