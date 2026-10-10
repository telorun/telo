---
description: "How the SQL family keeps drafted graph layers: a draft row beside a published row, the layer revision counter, the two bookkeeping tables, the drafted store's rules, and what each operation writes."
sidebar_label: Drafted layers — SQL
---

# Drafted layers in SQL

`GraphLayersSql.DraftedStore` is the SQL family's store for the [drafted level](../../graph-layers/docs/drafting.md) of the layered contract. A strategy module — `graph-layers-drafts-sqlite`, `graph-layers-drafts-postgres` — declares the concrete kinds; this page is what they share. The node and relationship abstracts, their rules and everything in [Layered tables](layered-sql.md) apply unchanged.

## How a drafted layer is stored

Each typed table holds, for one layer and one key, **at most one published row and one draft row**. Beside `graph_layer` and `graph_effect` a row carries:

| Column | Holds |
| --- | --- |
| `graph_layer` | the layer's internal id, from the layers table — not its name |
| `graph_state` | `draft` or `published` |
| `graph_effect` | `stated` or `removed`; on a draft row also `retracted` — the draft withdraws the layer's own published statement |
| `graph_revision` | the layer revision that published the row; null on a draft row |
| `graph_over` | on a draft row, the `graph_revision` of the published row it was written over or last rebased onto; null when there was none |
| `graph_written_at` | when the row was written, by the database's clock |
| `graph_resolution`, `graph_resolved_by_type`, `graph_resolved_by_id` | how a conflict on the row was decided (`mine`, `theirs`, `merged`) and by whom; null otherwise |

The table's indexes lead on `graph_layer` then `graph_state`, then the key: unique (`graph_layer`, `graph_state`, key), and for a relationship (`graph_layer`, `graph_state`, source, target) and (`graph_layer`, `graph_state`, target, source). **State leads the key**, so a layer is two contiguous ranges — its published rows and its draft rows — and each reader, and each operation over a draft as a whole, seeks exactly what it reads. With the key first a layer's draft rows would lie scattered through its published ones: a published page would walk every key the draft alone holds, and publishing would walk the layer.

A layer has **one open draft**, so the draft rows of a layer are that draft's. Two bookkeeping tables, declared with the strategy's `LayersTable` and `DraftsTable` kinds and listed in the schema like every other table, hold the rest: the layers table registers each layer with its internal id and `head_revision`; the drafts table records each draft — its public id, layer, parent revision, who opened, published or discarded it and when, and the revision it became. A draft has no state column: open, published and discarded are read from its timestamps.

**A layer's row is created by the layer's first write** — a node or relationship write outside a session, or `OpenDraft` — inside that write's own atomic operation, and by nothing else: a read never writes. A read that finds a layer of its stack with no row reads it as holding nothing (the store's own layer as empty at revision 0, a base as contributing nothing) and remembers nothing from it. Every instant is written through the engine schema's own current-instant expression (`SqlInstantSchema.currentInstant` in `@telorun/sql`), so the store names no engine's clock; a schema instance without the member is refused when the store is created.

## Rules of the drafted store

Declared once on the abstract and inherited by the concrete store kinds, each reported by `telo check` and refused again at creation under the same code:

| Code | Refuses |
| --- | --- |
| `GRAPH_TABLE_NOT_IN_SCHEMA` | a type's table, or the `layers` or `drafts` table, that the store's schema does not list |
| `GRAPH_SCHEMA_CONNECTION_MISMATCH` | a schema on another connection than the store's |
| `GRAPH_TABLE_SHARED` | one table named twice among the types and the two bookkeeping tables |
| `GRAPH_BASE_STORE_MISMATCH` | a base on another connection or schema, or one that keeps its layers or drafts in another table — a layer and its bases are registered in one layers table |
| `GRAPH_BASE_LAYER_DUPLICATE` | the same layer twice among `bases:`, or a base naming the store's own `layer` |

Resources a store reaches must have distinct resource names, across modules too: these rules compare by resource name, as [on every layered store](layered-sql.md#rules-of-the-layered-types).

The stack is the one of the current strategy — the store's layer, then each base in order followed by its stack, a shared layer at its lowest place — and, as there, the store's own layer reached deeper than its direct bases is refused at creation only, and a cycle among `bases:` is the analyzer's `DEPENDENCY_CYCLE`.

## Reads

Outside a session every layer of the stack is read by its published rows. Inside one, the top layer is read by **the draft's row when it has one for the key, else its published row**; a `retracted` draft row makes the layer say nothing, so whatever the bases state shows. The bases are always read by their published rows.

The overlay is the current strategy's — an index probe per higher layer, never a resolution of the stack — over the state-first indexes, and **every statement names the state it reads**: a probe is an equality on layer, state and key, and a range never crosses from one state's rows into the other's. A read of both of a layer's rows for a key asks for both states by name.

- **Outside a session** each layer contributes one branch to a page, its published range. A draft's rows are in another range, so a published page costs the same whatever a draft holds: `limit` × depth for nodes, that times twice the depth again for relationships, as [there](layered-sql.md#paging-and-cost).
- **Inside a session** the top layer contributes **two** branches: its draft range, and its published range minus the keys the draft holds. What the top layer says for a key is the draft probe, then the published one. A node page therefore reads depth + 1 ranges, each at most `limit` + 1 rows it keeps, a row it passes over counting with the row found above it — at most 2 × (depth + 1) × (`limit` + 1) rows in all — and that is independent of the size of the layer and of the draft: the draft branch seeks to the cursor like every other.

Every probe of a layer above is a scalar subquery, never `NOT EXISTS`: a planner is free to answer an anti-join by hashing the whole range it probes — a draft, or on a small table the layer above — and a page would then cost that range's size.

## Writes

**Outside a session** the store takes the layer's row in the layers table, writes the published row in place stamped with the next revision, and advances `head_revision` — one atomic operation. Published writes to one layer are therefore applied one at a time; a bulk load belongs in a draft. An operation that changes nothing leaves the revision where it was.

**Inside a session** every write is preceded, in its own transaction, by a conditional update of the draft's row in the drafts table that matches only while the draft is open. It holds that row until the write commits, so the database decides between the write and the draft being published or discarded. When it matches nothing, the store ends the session ([the contract](../../graph-layers/docs/store-contract.md#sessions-and-cancellation)).

| Operation in a session | What is written |
| --- | --- |
| create | a `stated` draft row |
| merge, update | the draft row in place; else a draft copy of the published row, or of the winning row of a base, with the change |
| delete | a `removed` draft row when a base states the key; a `retracted` one when only the layer's own published row does; the draft row dropped when nothing else would show |
| delete of a node | additionally, per relationship type touching it: a draft statement over a published one becomes its retraction, a draft statement with none is dropped, and an untouched published statement gets a retraction. Nothing is written for relationships a base states |
| retract | a `retracted` draft row over the layer's published statement; the draft row dropped when the layer has published none |

Every draft write records the revision of the published row it stands over in `graph_over`.

**A write whose source a concurrent delete removed answers as after that delete.** A copy reads its source inside its own statement — the layer's published row, which a session does not hold, or a base's row, which another layer's writer holds — and with nothing there it writes nothing: an update answers `absent`, and a merge states the key as a new value — the given columns only, so the engine applies each other column's default — standing over nothing when the vanished row was the layer's own published one. Where the copy would replace a draft row, it is one statement over that row, so the row stands untouched. Nothing is retried, and both answers are the serial order "the delete, then this write".

**A delete answers `found` only when a statement of its own made the key absent.** Its removal is a copy of the row it hides; when that row is gone the store reads the key again in the same operation and states the removal over the value a lower layer still shows, and answers `absent` when nothing shows it any more. Each further read is of a lower winner, so there are at most as many as the stack has layers, and more than that is an error naming the bound.

## Publish, discard, rebase

- **Publish** takes the draft's row and the layer's row, refuses a draft whose parent is not the layer's revision (`draftStale`) or that has a conflict (`draftConflicted`), then for each table deletes the published rows the draft replaces — found through the draft's keys — drops the draft's retractions, and turns the remaining draft rows into published rows of revision head + 1. It joins the caller's transaction or commits on its own. A draft with no row publishes as the revision the layer is at.
- **Discard** deletes the draft's rows and stamps the draft.
- **Rebase** drops the draft rows whose published side moved and now says the same — equal values, a removal on both sides, a retraction of a statement already gone — then counts what is left and moves the draft's parent to the layer's revision.

A draft row is **in conflict** when `graph_over` no longer equals the `graph_revision` of the layer's published row for the key and the two rows do not say the same thing. The comparison is two-way, row against row: there is no ancestor row, so two sides changing different properties of one key is one `changed-both`. `graph_over` tracks the layer's own published row only, so a change in a base is never a row conflict and never makes the draft stale.

`endpoint-missing` is read as two driven sets, never as a filter over the layer's relationships: the draft's own stated relationships, and — for each node the draft removes or retracts — the layer's published relationships at that node which the draft leaves standing, reached through the source-led and the target-led index. A base that removes an endpoint of a relationship the draft states therefore leaves the draft conflicted. A relationship of the layer that a base orphans with no draft involved is simply out of the view, as on every strategy.

Deciding a conflict is a conditional write on the draft row that names the `graph_over` the conflict was read with, so it applies once. A conflict's token is built from what its row stands on: `graph_over` for a draft row, and its own `graph_revision` for a published relationship the draft never touched — so a token taken before either is written again no longer names the conflict.

### What the draft-wide operations read

Publish, the convergent merge of a rebase, the count of rows the layer moved under, the test for any draft row, discard, and both conflict listings are **driven from the draft's range**: they read the draft's rows and reach a published row only by probing for a key the draft holds. The published rows a publish replaces are deleted through the draft's keys, not by reading the published range for rows that have a draft twin. So each costs in proportion to the draft — plus, for the endpoint check, the relationships at nodes the draft removes or retracts — and not to what the layer holds.

A conflict page is bounded the same way, **not by `limit`**: conflicts are not stored, so a page reads the draft and those relationships whole, then orders and cuts.

Two of those statements are joins whose order the engine's planner chooses by cost — the delete of replaced published rows, and the relationships at withdrawn nodes. They are written so that the draft's side is the small, indexed one; where a draft is a large share of a small layer, a planner may still read the layer's range instead, because there that is cheaper.

## Cursors

A listing's tail is the last key, as on the current strategy. A tail issued in a session also carries the draft's public id and the revision the draft stood on; both are compared in code — against the session the call is in and the draft row it reads — before any statement names a value of the tail, and a mismatch is `cursorInvalid`.
