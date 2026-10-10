---
description: "Drafting a graph layer: opening a draft, draft sessions, atomic publish, staleness and rebase, the five conflict classes, resolving them by side or by any invocable, and what ends a session."
sidebar_label: Drafting
---

# Drafting

> Examples assume this module is imported under alias `GraphLayers`, `graph` under `Graph`, and a drafting strategy module under `Layers`.

Drafting is the second level of the layered contract. A store of that level extends `GraphLayers.DraftedStore`: its layer is edited in a **draft** and published atomically as a numbered **revision**. Everything on [the base level](graph-layers.md) still holds — the twelve `Graph` operations and the retract operations are the only way to read and write, inside a draft or outside one.

## Which level a kind needs

Every lifecycle kind is declared once, here, and its `store` slot names the lowest level at which it fully works. A kind over a store of a lower level is a `REFERENCE_KIND_MISMATCH` at `telo check`.

| Kind | `store` level | Purpose |
| --- | --- | --- |
| `RetractNode`, `RetractRelationship` | `Store` | Withdraw a layer's own statement. |
| `OpenDraft` | `DraftedStore` | Open a draft, or return the open one. |
| `DraftSession` | `DraftedStore` | Run a body of steps against one draft. |
| `Publish` | `DraftedStore` | Publish a draft as the layer's next revision. |
| `DiscardDraft` | `DraftedStore` | Drop a draft and everything staged in it. |
| `RebaseDraft` | `DraftedStore` | Move a draft onto the layer's current revision. |
| `ListDrafts` | `DraftedStore` | List a layer's open drafts. |
| `NodeConflicts`, `RelationshipConflicts` | `DraftedStore` | List a draft's undecided conflicts. Inside a session only. |
| `ResolveNodeConflict`, `ResolveRelationshipConflict` | `DraftedStore` | Decide one conflict. Inside a session only. |
| `ListRevisions` | `RevisionedStore` | List the revisions a layer has published. See [Revisions](revisions.md). |

## Revisions

A drafted layer has a revision number. Every publish, and every write made outside a draft that changes what the layer states, advances it by one in the same atomic operation as the write, so concurrent writers get consecutive numbers.

**A write that changes nothing is not a revision.** A merge or update whose values all equal what the layer itself already states for the key returns that value and writes nothing — so a message delivered twice does not turn an open draft stale, and inside a session it adds no draft row. Equal means the same value of the same type: the text `"7"` is not the integer `7`, and where there is doubt the write is made. A key the layer does not itself state is different: writing it, even with exactly the values a base states, makes the layer state it — its `origin` becomes this layer and it stops following the base — which is a change; the same write again is then none. **To leave a node following its base, do not write it.**

The revision number identifies the layer's state now; what a strategy keeps of earlier states is its own business (a drafts strategy keeps none).

## Outside a session and inside one

**Outside a session** a drafted store behaves as the base level does: a read sees the published statements of the stack — never a draft's — and a write changes the layer's published statement in place, advancing the revision. It records no draft.

**Inside a session** every graph or lifecycle operation reached through the session's body on that store reads and writes the draft:

- a read sees the draft's statements over the layer's published ones, then the bases' published ones. A base's draft is never visible above it;
- a write is staged in the draft and visible only inside sessions on it. A second write to a key replaces the first;
- create, merge, update, delete and retract follow the base level's rules against that view. Deleting a key hides it; withdrawing the layer's own published statement is staged as a retraction, and takes effect at publish;
- the view rule holds: a relationship is in the session's view only while both its endpoints resolve there.

```yaml
kind: Run.Sequence
metadata: { name: importBatch }
steps:
  - name: open
    invoke: { kind: GraphLayers.OpenDraft, store: !ref team }
    inputs: { message: nightly import, actor: { type: service, id: importer } }
  - name: stage
    inputs: { draft: !cel "steps.open.result.draft.id" }
    invoke:
      kind: GraphLayers.DraftSession
      store: !ref team
      inputs: { draft: !cel "inputs.draft" }
      steps:
        - name: add
          invoke: { kind: Graph.MergeNode, store: !ref team, node: !ref person }
          inputs: { key: ada, properties: { name: Ada } }
  - name: publish
    invoke: { kind: GraphLayers.Publish, store: !ref team }
    inputs: { draft: !cel "steps.open.result.draft.id" }
```

`DraftSession` takes `store`, a body of `steps` in the shared step grammar and `inputs:` forwarded into it; it is invoked with `draft` and returns the body's step results. The session is a zone on the body, correlated on the store: a session on one store says nothing about another.

## The operations

| Operation | Inputs | Output | Throws |
| --- | --- | --- | --- |
| `OpenDraft` | `message?`, `actor?` | `draft { id, parentRevision, createdAt }`, `opened` | — |
| `DraftSession` | `draft`, and the body's | the body's step results | the body's, `GRAPH_DRAFT_NOT_FOUND`, `GRAPH_DRAFT_CLOSED`, `GRAPH_DRAFT_FOREIGN` |
| `Publish` | `draft`, `message?`, `actor?` | `revision { number, publishedAt }`, `changed` | `GRAPH_DRAFT_NOT_FOUND`, `GRAPH_DRAFT_DISCARDED`, `GRAPH_DRAFT_STALE`, `GRAPH_DRAFT_CONFLICTED` |
| `DiscardDraft` | `draft`, `actor?` | `{}` | `GRAPH_DRAFT_NOT_FOUND`, `GRAPH_DRAFT_PUBLISHED` |
| `RebaseDraft` | `draft` | `parentRevision`, `merged`, `conflicts` | `GRAPH_DRAFT_NOT_FOUND`, `GRAPH_DRAFT_CLOSED`; over a revisioned store also `GRAPH_BASE_REVISION_CONFLICT`, `GRAPH_BASE_LIMIT` |
| `ListDrafts` | `limit?`, `cursor?` | `drafts[] { id, parentRevision, stale, message?, createdAt, createdBy }`, `next?` | `GRAPH_CURSOR_INVALID` |

- A draft's `id` is its public id (`gdr_…`); it is what every other operation takes.
- `actor` is `{ type, id }` in the application's own vocabulary (the `GraphLayers.Actor` shape). Omitted, the store itself is recorded, as `{ type: store, id: <the store's declared name> }` — the same whatever alias the application imports the strategy under. Who opened, published and discarded a draft, and when by the database's clock, is kept with it.
- A store that keeps one draft per layer answers `OpenDraft` with the open one and `opened: false`. Opening never fails for racing a publish or another open: whichever order the database takes them in, the call is answered with the layer's open draft or a new one.
- `GRAPH_DRAFT_CLOSED` carries `data: { draft, closedAs: published | discarded, revision? }`.

### Publish

Publishing applies every statement of the draft at once as the layer's next revision, in one atomic operation: it joins the caller's `Sql.Transaction` when one is open and otherwise commits on its own.

- It succeeds only while the layer is still at the revision the draft stands on. Otherwise it is `GRAPH_DRAFT_STALE`: [rebase](#rebase-and-conflicts) and publish again. Stale means exactly that — the layer's revision is not the draft's parent — and nothing else: a write in a **base** moves no revision of this layer and never makes its draft stale.
- It is refused with `GRAPH_DRAFT_CONFLICTED` while a conflict is undecided, or while the draft states a relationship whose endpoint does not resolve in the view being published — whoever removed the endpoint, a base included.
- Publishing a published draft answers with the revision it became.
- A draft with no change creates no revision: `changed: false`, and `revision.number` is the revision the layer was already at.

### A draft closed while a session runs

A draft can be published or discarded while a session on it is running — by another process, or by the session's own body. The session ends there:

- the operation that finds the draft closed stops, and **nothing in the body can catch it**: no `try:` around the step runs its `catch:`, and no later step is dispatched;
- `DraftSession` fails with `GRAPH_DRAFT_CLOSED`, carrying how the draft was closed;
- what the body staged before the draft was published is in that revision; what it tried afterwards is in no revision and no draft.

Each session operation checks that the draft is open as part of its own write, and the database decides between that write and the draft being closed — there is no claim to renew and no heartbeat. A session opened on a draft that is already closed fails the same way before its body starts.

## Rebase and conflicts

`RebaseDraft` moves a draft onto the layer's current revision. Changes both sides made alike are merged without asking — both set the same values, both added the key with equal properties, both removed it. Everything else is left as a **conflict**. `merged` counts the former, `conflicts` the latter.

| Class | Means |
| --- | --- |
| `changed-both` | Both sides changed the key. `properties` names what they disagree on. |
| `changed-removed` | The draft changed a key the layer has since removed. |
| `removed-changed` | The draft hides or retracts a key the layer has since changed. |
| `added-both` | The draft added a key that now exists, with different properties. |
| `endpoint-missing` | A relationship the layer states whose endpoint does not resolve in the view being merged or published: one the draft states, or one the layer has already published at a node the draft removes or retracts. |

**How much merges by itself depends on what the store keeps.** A drafts store keeps one draft row beside one published row and compares the two directly. A [revisioned store](revisions.md) still holds the row the draft was written over — the two sides' common ancestor — and compares each side with it, property by property.

| The two sides | Drafts store (two-way) | Revisioned store (three-way) |
| --- | --- | --- |
| Each changed a *different* property of one key | one `changed-both`, naming both properties | merged; no conflict |
| Both changed the *same* property to different values | `changed-both`, naming every property that differs | `changed-both`, naming only that property; a property one side alone changed is merged into whichever side is taken |
| Both made the same change | merged | merged |
| The draft changed a key the layer has since removed | `changed-removed` | `changed-removed` — merged as a removal when the draft's row holds what the ancestor held |
| The draft removed a key the layer has since changed | `removed-changed` | `removed-changed` — merged as a removal when the layer's row holds what the ancestor held |
| `base` on a listed conflict | never | the ancestor, for a conflict that has one |
| Drafts open on a layer at once | one; `OpenDraft` returns it | any number; `OpenDraft` always opens another |
| What a session reads beneath its draft | the layer's published state now | the layer at the draft's parent revision, until rebased |
| The layers beneath | declared, read as they are now | pinned; a moved pin is merged the same three ways, and a rebase re-applies the draft's own pin changes onto the head's ([Revisions](revisions.md#upgrading-is-a-pin-move)) |

`NodeConflicts` and `RelationshipConflicts` list a draft's undecided conflicts a page at a time (`limit`, `cursor`), in key order:

```
conflicts[] { key | source, target, class, properties?, mine?, theirs?, base?, token }
```

`mine` is what the draft states and `theirs` what the layer now publishes; each is absent when that side states no value. `base` is what both started from, where the store keeps it. For an `endpoint-missing` relationship the draft never touched, `mine` is the relationship as the layer publishes it. `token` names the conflict in its present state: it stops matching as soon as either side is written again. Following `next` passes over conflicts left undecided. A relationship listed as `endpoint-missing` is out of the session's view until it is decided.

**Conflicts are not stored.** A listing compares the draft with the layer as it stands when the page is read, so a page costs in proportion to the size of the draft and to the relationships at the nodes the draft removes or retracts — not to `limit`, and not to the size of the layer.

### Resolving

`ResolveNodeConflict` (`key`) and `ResolveRelationshipConflict` (`source`, `target`) take:

| Input | Meaning |
| --- | --- |
| `take` | `mine` keeps the draft's statement; `theirs` drops it for what the layer publishes. |
| `set?` | Property values applied on top of the taken side, typed from the node or relationship type. |
| `token?` | The listed `token`. Given, the decision applies only while the conflict is still that one. |
| `resolvedBy?` | Who decided (`Actor`). Omitted, the store itself: `{ type: store, id: <its name> }`. |

They return the node or relationship the draft now shows for the key — absent when the decision leaves no statement visible.

A draft holds statements to publish, so a decision is recorded — how, and by whom — only where it leaves one: `mine`, a side with `set` on top, and `theirs` on `endpoint-missing`, which leaves the relationship's removal. Plain `theirs` drops the draft's statement and leaves nothing to record.

| Class | `take: mine` | `take: theirs` |
| --- | --- | --- |
| `changed-both` | the draft's values | the published values |
| `changed-removed` | keeps the statement | accepts the removal |
| `removed-changed` | keeps hiding | lets it show |
| `added-both` | keeps the override | drops it |
| `endpoint-missing` | `GRAPH_RESOLUTION_INVALID` — restore the endpoint node instead, which clears the conflict | removes the relationship |

- `GRAPH_RESOLUTION_INVALID` — the decision cannot apply: `mine` on `endpoint-missing`, or `set` where the taken side states no value. Nothing is written and the conflict stays.
- `GRAPH_CONFLICT_NOT_FOUND` — no conflict stands on the key, or `token` names one that has since changed. A decision is one conditional write: of two callers deciding the same conflict exactly one applies, and the other gets this code.
- An ordinary write to the key through any `Graph` operation inside the session also settles its conflict, keeping the caller's version.

Both kinds require the session zone on their store: outside one, `telo check` reports `ZONE_REQUIREMENT_UNSATISFIED`, and the kind refuses at dispatch with `ERR_ZONE_REQUIRED`.

### Automating decisions

Deciding is ordinary steps. List a conflict, `switch` on its `class` (and `properties`), take a constant side for the cases you call mechanical, invoke **any invocable** for the rest, then resolve:

```yaml
kind: GraphLayers.DraftSession
metadata: { name: decideAll }
store: !ref team
inputs: { draft: !cel "inputs.draft" }
steps:
  # A decided conflict leaves the listing, so the first entry is always the
  # next undecided one.
  - name: next
    invoke: !ref teamNodeConflicts
    inputs: { limit: 1 }
  - name: decide
    while: !cel "size(steps.next.result.conflicts) > 0"
    do:
      - name: byClass
        switch: !cel "steps.next.result.conflicts[0].class"
        cases:
          added-both:
            - name: keepMine
              invoke: !ref teamResolveNode
              inputs:
                key: !cel "steps.next.result.conflicts[0].key"
                take: mine
                token: !cel "steps.next.result.conflicts[0].token"
          changed-removed:
            - name: acceptRemoval
              invoke: !ref teamResolveNode
              inputs:
                key: !cel "steps.next.result.conflicts[0].key"
                take: theirs
                token: !cel "steps.next.result.conflicts[0].token"
        default:
          - name: ask
            invoke: !ref decider
            inputs: { class: !cel "steps.next.result.conflicts[0].class" }
          - name: applyAnswer
            invoke: !ref teamResolveNode
            inputs:
              key: !cel "steps.next.result.conflicts[0].key"
              take: !cel "steps.ask.result.take"
              token: !cel "steps.next.result.conflicts[0].token"
      - name: next
        invoke: !ref teamNodeConflicts
        inputs: { limit: 1 }
```

`decider` is whatever answers: a rules table, a model call, or a kind that files the conflict in a review queue and returns once a person has answered. The graph modules import none of them, and the store retries nothing — a decider that fails or times out fails its step by the step grammar (`retry:`, `timeout:`, `try:`), and the conflict stays listed for the next pass. For a queue a person answers hours later, list the conflicts into the queue in one session and apply each answer in a later one; `token` is what makes a late answer safe.

An external call made inside an enclosing `Sql.Transaction` holds that transaction — and the connection — open for as long as the call takes. Put the deciding session outside any transaction, or decide first and resolve inside one.

## Cursors

`ListDrafts` and the two conflict listings page through the cursor every `Graph` listing uses, bound to their own operation: a cursor of one listing resumes no other, on the same store and type or not. A listing's cursor is also bound to what it was read from. Outside a session that is the published state — on a revisioned store, the one revision the listing's first page was read at, which every later page stays on. Inside one it is the draft as it then stood: a cursor read in a session is `GRAPH_CURSOR_INVALID` outside it, in a session on another draft, and after the draft has been rebased; a cursor read outside is `GRAPH_CURSOR_INVALID` inside. Listings are keyset pages over live rows: no key is returned twice, and every key present for the whole listing is returned once.

## Rules

| Code | Declared on | Refuses |
| --- | --- | --- |
| `GRAPH_TYPE_NOT_IN_STORE` | the four conflict kinds | a node or relationship type the store does not list |

Reported by `telo check` and refused again, under the same code, when the resource is created.
