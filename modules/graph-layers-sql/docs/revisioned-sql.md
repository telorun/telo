---
description: "How the SQL family keeps revisioned graph layers: one row per version of a statement, changesets that are drafts and then revisions, base lists pinned per revision, the index set and the access path each index serves, the three-way merge, the pin-move pass, and what each operation reads and writes."
sidebar_label: Revisioned layers — SQL
---

# Revisioned layers in SQL

`GraphLayersSql.RevisionedStore` is the SQL family's store for the [revisioned level](../../graph-layers/docs/revisions.md) of the layered contract. A strategy module — `graph-layers-revisions-sqlite`, `graph-layers-revisions-postgres` — declares the concrete kinds; this page is what they share. The node and relationship abstracts and their rules apply unchanged, as does the view rule of [Layered tables](layered-sql.md).

A revisioned layer's stack is data: the store has no `bases` (writing one is a `SCHEMA_VIOLATION`), and what it is built on is a base list stored in the `changesetBases` table and set by `PinBase`.

## How a revisioned layer is stored

One mechanism: **every row of a typed table is one version of one layer's statement about one key, written by exactly one changeset.** A changeset is a draft while open and a numbered, immutable revision of its layer once published. History is the rows themselves, each with the range of revisions it was current for.

| Column | Holds |
| --- | --- |
| `graph_row` | the row's own id (UUIDv7), the primary key. It never leaves the store. |
| `graph_layer` | the layer's internal id, from the layers table |
| `graph_changeset` | the changeset that wrote the row |
| `graph_from_revision` | the revision the row became current at; null while its changeset is a draft |
| `graph_to_revision` | the revision the row stopped being current at; null while it is current |
| `graph_effect` | `stated`; `removed` — the layer hides a key a layer beneath states, a full row carrying the values it hides; on a draft row also `retracted` — the draft withdraws the layer's own statement |
| `graph_over` | on a draft row, the `graph_row` of the layer's own row the draft was written over or last rebased onto; null when there was none. The own-layer ancestor. |
| `graph_beneath` | the `graph_row` of the winning statement among the layer's bases that this row was written over or last reconciled with; null when nothing beneath stated the key. Set by every write and carried by a copy. The beneath ancestor. |
| `graph_resolution`, `graph_resolved_by_type`, `graph_resolved_by_id` | how a conflict on the row was decided (`mine`, `theirs`, `merged`) and by whom; null otherwise |

Three bookkeeping tables, declared with the strategy's `LayersTable`, `ChangesetsTable` and `ChangesetBasesTable` kinds and listed in the schema like every other table:

| Table | Holds |
| --- | --- |
| layers | `id`, `name` (unique), `head_revision`, who registered the layer and when. A row is created by the first call that changes the layer — a node or relationship write outside a session, `OpenDraft`, or a pin move that changes the base list — in that operation. A read never creates one, and neither does a refused call or one that changes nothing: `LabelRevision` never does, and a `PinBase` / `UnpinBase` on a layer with no row is first judged against a layer holding nothing (no bases, revision 0), then judged again under the layer's row once it is a change. A layer with no row reads as empty at revision 0 |
| changesets | `id`, `public_id` (unique, `gdr_…` — the only name of a draft that leaves the store), `layer_id`, `parent_revision`, `revision` (unique per layer once set), `message`, who opened, published or discarded it and when; `label`, `labelled_at`, `labelled_by_type`, `labelled_by_id` — the revision's label; and `bases_changeset` — the changeset whose rows in the bases table are this one's base list, null for a layer built on none |
| changeset bases | `id`, `changeset_id`, `position`, `base_layer_id`, `base_revision`: one row per direct pin of one base list |

**A base list is stored once per change, not once per changeset.** A write, a publish and a new draft inherit their parent's `bases_changeset`; the first pin change in a changeset writes the whole new list under that changeset's own id and points at it. So a layer that pins once and is written a million times holds one list. A published list is immutable, and so is the stack beneath a published revision; the store resolves each once.

A changeset has no state column: open, published and discarded are read from its timestamps. A write made outside any draft that changes what the layer states is a changeset opened and published in one operation, by the store itself (`{ type: store, id: <the store's declared name> }`); one whose values all equal the layer's own statement writes no row and no changeset. A published draft that changed nothing has a `published_at` and no `revision`.

**Retained history is unbounded.** Nothing ends a row but a later revision, and nothing removes an ended row; there is no compaction.

## The index set

Three ranges are read, each through an index of its own, and every statement names the one it reads.

| Index | On | Serves |
| --- | --- | --- |
| primary key | `graph_row` | one row by id: the ancestor and the layer's row a conflict is judged from |
| changeset, unique | (`graph_changeset`, key) | one row per changeset and key; a draft's rows as one contiguous range — a session's reads and writes, publish, rebase, discard, the conflict listings |
| current, unique, partial | (`graph_layer`, key) where the row is published and not ended | at most one current statement per layer and key, kept by the database; the row a publish ends |
| published, partial | (`graph_layer`, key, `graph_from_revision`) where the row is published | every read of a layer as of a revision |

A relationship table has the same four over (source, target), and the changeset and published ranges a second time leading on the target — (`graph_changeset`, target, source) and (`graph_layer`, target, source, `graph_from_revision`) — so a hop followed backwards is as cheap as one followed forwards, inside a draft and outside one.

**The published index holds no draft row.** A draft row carries its layer, so an index over (layer, key) that held every row would put each draft's rows in every reader's range; a bulk load staged in a draft would then slow every published page beside it. The partial predicate is what keeps a reader's range to what is published.

The changesets table has unique (`layer_id`, `revision`) — a layer's history in order — a partial (`layer_id`, `public_id`) over open changesets, which is the order `ListDrafts` returns, and a partial unique (`layer_id`, `label`) over labelled rows: one label names one revision of a layer, kept by the database. The bases table has unique (`changeset_id`, `position`) — a list read whole, in order — and unique (`changeset_id`, `base_layer_id`): a list holds a layer once.

`graph_beneath` is in no index. A pin move reads the layer's own statements through the indexes above and compares the column in what it has read.

Two engine facts shaped this. No index is unique over a single column (a column's own `unique` flag does that for `name` and `public_id`), because both engines' schema passes read a one-column unique index back as a column flag and refuse the table on its second boot. And no index's `where:` is ever changed under an unchanged name and column list, because the schema pass compares an index by name, columns and uniqueness alone.

## Rules of the revisioned store

| Code | Refuses |
| --- | --- |
| `GRAPH_TABLE_NOT_IN_SCHEMA` | a node or relationship type's table, or the `layers`, `changesets` or `changesetBases` table, the schema does not list |
| `GRAPH_SCHEMA_CONNECTION_MISMATCH` | a schema on another connection than the store's |
| `GRAPH_TABLE_SHARED` | one table named twice among the types and the three bookkeeping tables |

Resources a store reaches must have distinct resource names, across modules too: these rules compare by resource name, as [on every layered store](layered-sql.md#rules-of-the-layered-types).

Each is reported by `telo check` and refused again under the same code when the store is created. Over node or relationship types another library exported the rules run too: a rule reads the references of a declaration that reaches it through an import as the declaring library wrote them.

## The stack

A layer's stack at one of its revisions is the layer, then each row of that revision's base list in position order followed by the stack of the pinned layer at the pinned revision; a layer reached more than once keeps its lowest place. One layer at two revisions (`GRAPH_BASE_REVISION_CONFLICT`), the store's own layer beneath itself (`GRAPH_BASE_CYCLE`) and more than 32 layers (`GRAPH_BASE_LIMIT`) are refused when a pin is set, on the stack at the pinned revisions. Resolving a stack reads only the changesets and bases tables — a few rows — and each published list and each stack beneath a published revision is read once per store resource.

## Reading

A read names, for every layer of the stack, the revision it reads that layer at, and — inside a session — the changeset whose rows lie over the store's own.

- **Outside a session** the store's layer is read at its head, read from the layers table, over the bases that revision pinned; a paged listing carries the revision in its cursor, so every later page reads that same revision and that same stack.
- **Inside a session** the store's layer is read at the draft's parent over the draft's base list, and the changeset's row for a key replaces the layer's: a `retracted` row makes the layer say nothing.

A versioned table has no state column, so the overlay reads it through **one bare scan per layer of the view, plus one for the draft**. Each scan tags its rows with its state and its place in the stack, and each alias is narrowed beside it: `graph_changeset = ?` under the draft tag, `graph_layer = ? AND graph_from_revision <= ? AND (graph_to_revision IS NULL OR graph_to_revision > ?)` under each layer's own — that layer's id and the revision it is pinned at. The scans carry no predicate of their own, because a planner joins through a `UNION ALL` only when its arms are bare scans; under each arm the tag folds the narrowing to that arm's own index condition, one range of the published index. Precedence is the place tag: the winner is the first place that says anything.

As everywhere in a layered table, every probe is `(SELECT … LIMIT 1) IS NULL`. On a versioned table the probes of one row are also written as **one expression, evaluated in order** — a chain of `CASE WHEN … THEN … ELSE FALSE END` — rather than as conditions joined by `AND`. Joined by `AND`, a planner estimates each probe separately and multiplies: a few probes in, it expects a page to keep almost none of the rows it reads, and it answers by reading the whole range and sorting it. It may also evaluate the probes in whatever order it prices cheapest, where the written order — own layer first — is the one that stops early.

**What a page costs.** A node page reads, from each layer of the stack, its own first `limit` + 1 visible winners through one range of the published index, with one probe of each layer above: `limit` × depth, or 2 × depth × (`limit` + 1) rows at most outside a session. Inside one the draft is one more range. A relationship page is that times twice the depth again — each endpoint resolved by one probe per layer of the node table. A traversal is one statement, each hop reaching each layer's relationships through the index that leads on the endpoint it enters by; a page costs at most one walk of its reach, and no page more than the first.

None of that depends on the size of a table, on how far the cursor has come, on the size of a draft or of its siblings, or on the revisions a base published after it was pinned when they touched other keys: a pin reads what it pinned at the cost of reading a head. **A page that crosses a key rewritten many times reads its versions** — every version of a key lies in the range a page crosses.

## Writing

**Outside a session** a write is one retained revision, in one atomic operation that joins the caller's `Sql.Transaction` or commits on its own. It takes the layer's row, ends the layer's current row for the key at head + 1, writes its successor as a row of a changeset of its own, advances the head by an increment on the layer's row and records the changeset as published. A write that changes nothing makes no revision.

So **published writes to one layer are applied one at a time**: each holds the layer's row until it commits. Concurrent writers queue on that row and get consecutive revisions, with no retry and no refusal. A bulk load belongs in a draft, where writers contend on nothing but their own changeset.

**Inside a session** a write makes or changes the changeset's row for the key, taken together with the changeset's own row — a conditional update that matches only while the draft is open — so the database decides between the write and the draft being published or discarded. A draft's own row is changed in place; the layer's row is never changed: the changeset gets a copy of it with the change, standing over it. A delete or a retract of what the layer states is a `retracted` row over it; of what only the draft states, the row is dropped.

**What lies beneath decides what a delete writes.** A key that resolves from beneath is hidden by a `removed` row — published outside a session, a draft row inside — carrying the values it hides, with `graph_beneath` naming the hidden row; that holds too when the layer restates the key over one beneath. A key only this layer states has its statement withdrawn and leaves no row. A `removed` row in a base hides the key for every layer above. A hidden key is absent, so it can be stated again; the new statement replaces the `removed` row. Retract withdraws the layer's one statement, a removal included, and answers the row now resolved from beneath.

Every row a write makes records in `graph_beneath` the row then winning beneath the layer for its key, found by one probe per base layer.

A **node delete** writes the node's row and withdraws the layer's own relationships at it — outside a session by ending them; inside one by one `retracted` row per relationship the layer states there, the draft's own unpublished ones dropped. It writes nothing else.

## Publish, rebase, discard

Each is driven from the changeset's range and reaches the layer only for a key the changeset holds.

- **Publish** takes the changeset's row and the layer's row. It is refused as stale unless the head is the draft's parent, and as conflicted while a row of the changeset stands over a row that is not the layer's current one, records beneath it a row that is not the one now beneath, or a relationship the result would state has an endpoint that does not resolve. Then, as revision head + 1: the layer's current rows for the changeset's keys are ended, `retracted` rows are dropped, and every other row of the changeset becomes current — in the typed tables the changeset touched and no other. A changeset whose only change is its base list publishes a revision. **A publish holds the layer for a time proportional to the draft.**
- **Rebase** takes both rows, re-applies the draft's own pin changes onto the head's base list (refused, with nothing changed, when the result is no legal stack), reads the changeset's rows the layer has moved under, and merges each three ways against the row it stands over (below). What merges is written back and stood on the layer's current row, or dropped when nothing is left to say; what clashes is left as it is. Each row is then brought onto what lies beneath it by the pin-move pass (below) — and so are the layer's published statements, when the draft's base list is not the head's. The draft's parent becomes the head.
- **Discard** deletes the changeset's rows.

The replaced rows are joined to the changeset on the key, through the current-rows index, rather than on the row id each draft row stands over: a planner sizing a join reads the ends of the joined index, and over random row ids how many such reads it makes varies from run to run. Two statements — that one, and the layer's relationships at nodes a changeset withdraws — are joins the planner orders; both are answerable from the declared indexes.

## The three-way merge

For a row of the changeset whose `graph_over` is not the layer's current row for the key, three rows are compared: the draft's, the layer's current one, and the one `graph_over` names — still in the table, because nothing is removed.

| Draft | Layer now | Outcome |
| --- | --- | --- |
| states | states, ancestor known | per property: one side's change is taken; both to the same value is taken; both to different values clashes → `changed-both` naming those properties |
| states | states, no ancestor (both added) | equal → merged; else `added-both` |
| states | nothing (removed) | the draft holds what the ancestor held → merged as the removal; else `changed-removed` |
| retracts | states | the layer holds what the ancestor held → the retraction stands; else `removed-changed` |
| retracts | nothing | merged |

A decision takes a side for what clashed; a property only one side changed keeps that side's value either way. `set` applies on top. `take: theirs` leaves no row when the result is what the layer states. The decision is one conditional write naming the row the draft stood over when the conflict was read, so of two callers exactly one applies.

**Conflicts are not stored.** A listing reads the changeset's moved rows — and, for a relationship type, the layer's relationships at each node the changeset withdraws — then the layer's row and the ancestor of each row the page keeps, by id. A page is therefore bounded by the draft plus those relationships, not by `limit`, and not by the size of the layer.

A conflict's token is a digest of the ids of every row its class was decided from: the draft's row, the row it stands over, the layer's current row, and for a missing endpoint the rows the two endpoint nodes resolve to. The ids themselves never leave the store.

## Moving a pin

`PinBase` and `UnpinBase` change a base list and then bring every statement the layer makes onto the new stack — the **pin-move pass**.

The pass reads each statement the layer makes once, in key order, in batches of 500: the changeset's rows, and the layer's rows at the draft's parent that the changeset does not cover. For each it asks the new stack what lies beneath, by one probe per layer, and compares that row's id with `graph_beneath`. A statement whose pointer still matches is passed over. A mismatch goes to the same three-way merge, with the row `graph_beneath` names as the ancestor and the row now beneath as the other side:

| Outcome | A row of the changeset | A statement the layer had only published |
| --- | --- | --- |
| merges, something left to say | the merged values and the new pointer are written to it | a draft row over it is written, with the merged values and the new pointer |
| merges, nothing left to say — it now equals what is beneath, or both removed the key | it becomes a withdrawal of the layer's statement, or is dropped when the layer states none | a `retracted` draft row over it |
| clashes | left as it is: a conflict | copied into the changeset still carrying the old pointer, so the conflict is one of the changeset's rows |

A published relationship left standing whose endpoint does not resolve under the new stack is copied into the changeset the same way, which is how the listing finds it as `endpoint-missing`.

So after the pass **every beneath-mismatch left in the changeset is a conflict**, both conflict listings stay driven from the changeset's range, and publish counts them from the changeset's rows alone, one probe each. On one key the own-layer comparison is settled first; a key has one listed conflict at a time, and its token covers the rows of both comparisons.

**Inside a session** the pass writes to the session's draft and the move is published with it. **Outside one** it runs in a changeset of the store's own, holding the layer's row: with no conflict left the changeset is published as one revision; with any, the whole call is rolled back and answers `draftConflicted`. A move that leaves the list as it was writes nothing and makes no revision.

**What it costs**: the number of statements the layer itself makes, times one probe per layer of the new stack. It reads nothing of a base beyond those probes, so it is independent of the size of every base and of retained history — 200 statements cost the same over a base of 20,000 rows and of 200,000. It is not bounded by what changed beneath: an unchanged base still costs the walk. And since the walk outside a session holds the layer, **a large layer moves a pin inside a draft**.

## History and labels

`ListRevisions` reads the changesets table through (`layer_id`, `revision`): a layer's published changesets, in either order, optionally after a number, a keyset page at a time — the store's own layer, or any layer of the same tables by name. Each revision's `bases` is its base list, read from the bases table by `bases_changeset`. Neither it nor `ListBases` reads a row of a typed table.

`LabelRevision` answers `revisionNotFound` from a read for a layer with no row, which has no revision to label. Otherwise it takes the layer's row, reads the changeset rows holding that number or that label, and sets the label by an update that matches only while the revision has none. Labellers of one layer therefore apply one at a time and each is answered by an outcome — the loser is told which revision holds the label — while the partial unique index stays the database's own guarantee.

## Cursors

A tail carries the last key and what the listing was read at: outside a session the revision; inside one the draft's public id, its parent revision and a digest of the draft's direct base list — layer names and revision numbers, in order. Each is a selector, re-checked in code against the layer's head or the open draft before any statement names a value of the tail; only last-key values, layer ids and revisions reach the engine, as bound values.

A published revision's stack never changes, so no publish — of the layer, of a base, of a pin moved outside a session — invalidates a tail. A pin moved inside a draft changes that draft's digest, and its tails with it.
