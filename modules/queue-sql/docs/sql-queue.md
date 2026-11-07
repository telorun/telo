---
description: "The SQL family's durable work queue: the transactional enqueue, how messages are claimed by competing workers, group order, retention and the purge, waking, and what the table holds."
sidebar_label: Queue — SQL
---

# `QueueSql`

> Examples assume this module is imported under alias `QueueSql`, the [`queue`](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/) module under `Queues` (its kinds are written `Queue.*` in its own docs) and an engine module under `Queue`.

`QueueSql.Queue` implements the queue module's [store contract](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/) over one table of the application's own database. What delivery, retries and dead-lettering mean is the [queue module's](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/), decided by `Queue.Worker` the same way on every backend; this page is what is particular to keeping a queue in SQL.

## Declaring a queue

An engine module provides the two kinds you declare:

- a **table** kind (`QueuePostgres.Table`, `QueueSqlite.Table`) — the author writes one field, `table`, the physical name; every column and index belongs to the queue. List it in the engine `Schema`, which creates and migrates it.
- a **queue** kind (`QueuePostgres.Queue`, `QueueSqlite.Queue`) — `connection`, `schema` (the engine schema listing the table), `table`, `name`, and the queue module's `messageType`, `maxMessageBytes`, `retention` and optional `groupBy`.

`name` is the queue's durable identity inside its table, written into every row. Several queues share one table under different names; renaming the resource keeps its messages, renaming `name` does not.

## The transactional enqueue

`QueueSql.Enqueue` and `QueueSql.EnqueueMany` declare at their schema root that they run inside a `Sql.Transaction` on the queue's connection (`x-telo-requires-zone`, keyed on `/queue/connection`). The message is written on that transaction, so it is stored exactly when the transaction's other writes commit:

- **rolled back** — neither the data nor the message exists; no worker ever sees it.
- **committed** — both exist, and a worker claiming the message reads the data it is about.

`telo check` refuses an enqueue with no such transaction enclosing it — none at all, or one on another connection (`ZONE_REQUIREMENT_UNSATISFIED`); the kernel refuses the same manifest at load, and a call that reaches the operation outside one at run time is `ERR_ZONE_REQUIRED`.

The queue module's own `Queue.Enqueue` / `Queue.EnqueueMany` also work on a SQL queue: inside a transaction open on the queue's connection they join it, and otherwise they store the message in a transaction of their own. Use the `QueueSql` kinds when the message must commit with other writes — the check is what makes that a guarantee rather than a coincidence.

### Deduplication

An id names at most one message until `retention` has passed after it completed or was cancelled. Enqueueing an id the queue holds stores nothing: the same message (by the digest of its canonical body) answers `enqueued: false`, a different one is `ERR_QUEUE_ID_CONFLICT`. Two transactions enqueueing one new id concurrently meet at the table's unique index: the second waits for the first, then finds its message (it committed) or stores its own (it rolled back). A message settled longer ago than `retention` reads as absent: the enqueue removes its row and stores the new one, in the same transaction. Dead messages never expire.

## Claiming

`Queue.Worker` asks for up to its free slots at a time. One claim is one short transaction of the queue's own:

1. **Purge** — up to 100 completed or cancelled messages past `retention` are deleted, the first the settle-time index yields, passing over rows another transaction holds. This is the only cleanup: nothing is purged while no worker claims, and nothing depends on it, since an expired message already reads as absent.
2. **Lapsed cancels** — a running message whose cancel was requested and whose lease lapsed has no handler left to stop, so it is settled `cancelled` rather than delivered.
3. **Select** — first running messages whose lease lapsed, in the order their leases lapsed, then pending messages whose visibility time has come, earliest first and in enqueue order among equal times — each one range of an index on the state and that instant, so a claim reads only rows claimable now and never the messages scheduled for later. Rows another claimer holds are passed over (the engine Schema's lock-skipping clause).
4. **Take** — each selected row gets one claim token, a lease of `now + lease` and its attempt count incremented. A row that was running is reported `lapsed`, so the worker records `ERR_QUEUE_LEASE_EXPIRED` for the attempt that lapsed.

A held claim is renewed, completed, released or killed by its row and token; one whose row another claim has taken answers `lost` and changes nothing. A cancel requested while the message runs is applied at the next renewal (or when the attempt is released or dies).

### Group order

With `groupBy` (a plain chain over `message`, typed from `messageType` — `!cel "message.customerId"`), every message stores its group when it is enqueued, and a message is claimed only while it is the **oldest unsettled message of its group** — pending, scheduled, running or dead — and no other message of the group is held under a live lease. So a group's messages run one at a time, in enqueue order; a message waiting out a retry backoff holds its group; a dead message parks its group until it is requeued (keeping its place) or cancelled; and different groups run in parallel. Each probe — the oldest unsettled message of the group, and a message of the group under a live lease — is a scalar subquery reading the first entry of a partial index over unsettled (or running) rows, so the settled messages a group keeps for `retention` are never read. On a grouped queue every message must name its group: an item whose group member is absent or not a string is refused with `ERR_QUEUE_GROUP_INVALID` (`data.index`, its place in the batch) and nothing of its batch is stored. Enqueue order is the table's identity column: the order rows were inserted in.

## Waking

A worker polls an idle queue, backing off to a second. On an engine whose connection can `LISTEN` / `NOTIFY` (PostgreSQL), each queue also has a wake channel: an enqueue, a release, a requeue — and on a grouped queue a completion or cancellation — sends a notification, and a claim that finds nothing waits on the channel — or until the next scheduled message is due or the next lease lapses, each found as the first entry of an index range — and claims again when woken, for at most 5 s and never more than a sixth of the worker's `lease` (the worker reckons a lease from the moment it asked, so a longer wait would shorten the lease it believes it holds). A notification sent by an enqueue inside the caller's transaction is held by the database until commit and dropped on rollback. A wake only makes a claim prompt; the poll is what makes it correct, so a wake that never arrives costs latency, never a message.

## Instants and precision

Every instant is the database's clock, written through the engine Schema's instant members; the host clock only waits. A delay (`after`, a retry backoff) and an `after` instant are rounded **up** to the millisecond, so a message is never visible before the time it was given; instants read back (`enqueuedAt`, `visibleAt`, `settledAt`) are at millisecond precision.

## Bodies and errors

A message is stored as its canonical plain JSON body, byte for byte, with the envelope generation beside it — a producer or consumer outside Telo reads and writes the same text. A recorded failure (`lastError`, and the failure a dying message carries to its dead-letter handler) is stored as a typed frame, so its `data` comes back as the values it held.

## Statements read the clock once

Every statement reads the database's current instant as an uncorrelated subquery (`(SELECT <current instant>)`), so it is one value per statement that an index can be sought to. A bare instant function is volatile on PostgreSQL, and comparing an indexed column with it turns every index range into a filter over all rows.

## What exists in the database

One table per declaration, its columns all internal (no row contract sees them):

| Column | Holds |
| --- | --- |
| `seq` | identity primary key: enqueue order, and the tail a listing resumes after |
| `queue_name` | the queue's `name` |
| `message_id` | the message id |
| `group_key` | the message's group, or null |
| `state` | `pending`, `running`, `completed`, `dead` or `cancelled` (scheduled is pending with a future `visible_at`) |
| `body`, `digest`, `envelope_generation` | the canonical body, its SHA-256 and the envelope generation |
| `attempts` | claims made, less those handed back at shutdown |
| `enqueued_at`, `visible_at`, `lease_until`, `settled_at` | instants on the database's clock |
| `claim_token` | the token of the claim holding a running message |
| `last_error`, `dying_error`, `error_generation` | recorded failures as typed frames, and their frame generation |
| `cancel_requested`, `cancel_reason` | a cancel requested while running, and the reason given |
| `traceparent`, `tracestate` | the trace the message was enqueued in |

Indexes, each named `queue_<table>_…`:

| Index | Columns | Read by |
| --- | --- | --- |
| `_id` | unique (`queue_name`, `message_id`) | id identity, the enqueue's conflict target, `Status` / `Cancel` / `Requeue` |
| `_state` | (`queue_name`, `state`, `seq`) | listings in enqueue order |
| `_visible` | (`queue_name`, `state`, `visible_at`, `seq`) | claiming pending messages; an idle claim's next due message |
| `_lease` | (`queue_name`, `state`, `lease_until`) | claiming lapsed messages; lapsed cancels; an idle claim's next lapse |
| `_group_unsettled` | (`queue_name`, `group_key`, `seq`) where `state IN ('pending', 'running', 'dead')` | a group's oldest unsettled message |
| `_group_running` | (`queue_name`, `group_key`) where `state = 'running'` | a group's message under a live lease |
| `_settled` | (`queue_name`, `state`, `settled_at`) | the purge; expiry |

`Queue.Stats` counts every row of the queue, which is what `exact: true` promises; nothing else reads more than the rows it answers with. The layout is internal to `queue-sql` and changes only through the engine schema's migrations.

## Refusals

| When | `telo check` | Run |
| --- | --- | --- |
| `QueueSql.Enqueue` / `EnqueueMany` outside a transaction on the queue's connection | `ZONE_REQUIREMENT_UNSATISFIED` | refused at load; `ERR_ZONE_REQUIRED` at a call |
| An item without a string group on a grouped queue | — | `ERR_QUEUE_GROUP_INVALID`, nothing of the batch stored |
| The store finds one of its own invariants broken (a row neither stored nor found, a claimed row the update did not take, a recorded failure that does not read) | — | `ERR_QUEUE_STORE_INCONSISTENT` |
| Two queues with one `name` in one table | `REFERRER_RULE_VIOLATED` (`data.rule: QUEUE_NAME_DUPLICATE`) at each queue | `ERR_QUEUE_NAME_DUPLICATE` when the second is created |
| A `table` declared with a plain engine table kind | `REFERENCE_KIND_MISMATCH` | refused at creation |
| A `schema` instance without the store-clock and lock-skipping members | — | refused at creation |

Two queues with one name in one table would deliver, deduplicate and purge each other's messages. The rule is declared on each engine's table kind, which must extend its engine's `Table` with `base:` and so has one parent and inherits no rule; the runtime twin is a registry of the names claimed per table instance, shared by every engine.

## Runtime requirement

`requires: telo: ">=0.129.0"` — the controllers use the field-less `ctx.requireZone` and the engine Schema's `currentInstantPlus` / `instantParameter` / `skipLockedClause`.
