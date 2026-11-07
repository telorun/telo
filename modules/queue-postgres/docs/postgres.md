---
description: "The PostgreSQL engine of the SQL work queue: the table and queue kinds, what they create, and how skipped row locks, LISTEN/NOTIFY wakes and instants behave on PostgreSQL."
sidebar_label: Queue — PostgreSQL
---

# `QueuePostgres`

> Examples assume this module is imported under alias `Queue`, `queue-sql` under `QueueSql`, the `queue` module under `Queues` and `postgres` under `Postgres`.

What a queue guarantees, the transactional enqueue, claiming, groups and retention are [`queue-sql`'s](https://hub.telo.run/module/oci/ghcr.io/telorun/queue-sql/); delivery, retries and dead-lettering are [the queue module's](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/). This page is what is particular to PostgreSQL.

## Kinds

- **`Queue.Table`** — a `Postgres.Table` the author writes one field of: `table`, the physical name. List it in the `Postgres.Schema` that creates and migrates it (in that schema's namespace); the module issues no DDL. Several queues may share one table.
- **`Queue.Queue`** — `connection` (a `Postgres.Connection`), `schema` (the `Postgres.Schema` listing the table), `table` (a `Queue.Table`; a plain `Postgres.Table` is `REFERENCE_KIND_MISMATCH`), `name`, `messageType`, `retention`, and optionally `maxMessageBytes` and `groupBy`.

## What exists in the database

| Object | Definition |
| --- | --- |
| column `seq` | `bigint`, `GENERATED ALWAYS AS IDENTITY`, primary key |
| columns `queue_name`, `message_id`, `state`, `body`, `digest` | `text`, not null |
| columns `envelope_generation`, `attempts`, `cancel_requested` | `integer`, not null |
| columns `enqueued_at`, `visible_at` | `timestamptz`, not null |
| columns `lease_until`, `settled_at` | `timestamptz`, nullable |
| columns `group_key`, `claim_token`, `last_error`, `dying_error`, `cancel_reason`, `traceparent`, `tracestate` | `text`, nullable |
| column `error_generation` | `integer`, nullable |
| index `queue_<table>_id` | unique on (`queue_name`, `message_id`) |
| index `queue_<table>_state` | on (`queue_name`, `state`, `seq`) |
| index `queue_<table>_visible` | on (`queue_name`, `state`, `visible_at`, `seq`) |
| index `queue_<table>_lease` | on (`queue_name`, `state`, `lease_until`) |
| index `queue_<table>_group_unsettled` | on (`queue_name`, `group_key`, `seq`), partial: `state IN ('pending', 'running', 'dead')` |
| index `queue_<table>_group_running` | on (`queue_name`, `group_key`), partial: `state = 'running'` |
| index `queue_<table>_settled` | on (`queue_name`, `state`, `settled_at`) |

The layout is internal to `queue-sql` and changes only through the schema's migrations.

## Claiming

A claim selects its rows `FOR UPDATE SKIP LOCKED`, and so does the purge inside it: concurrent claimers in any number of processes pass over each other's rows instead of waiting. Two transactions enqueueing one new id meet at the unique index — the second waits for the first to commit or roll back.

## Waking

`Postgres.Connection` can `LISTEN` / `NOTIFY`, so each queue has a channel, `telo_queue_<digest of the table and name>`. An idle worker's claim waits on it — or until the next scheduled message is due, for at most 5 s and never more than a sixth of the worker's `lease` — and claims as soon as an enqueue, a release, a requeue (or, on a grouped queue, a completion or cancellation) sends a notification. A notification sent by an enqueue inside the caller's transaction is delivered at commit and dropped at rollback. The subscription holds one extra connection per connection object, opened on the first claim and closed when the queue is torn down; a subscription that fails is reported and retried, and claims poll meanwhile.

## Instants

Every instant is `clock_timestamp()` — the database's clock, never the transaction's start — shifted by a bound interval, and read once per statement as `(SELECT clock_timestamp())`: the bare function is volatile, so compared with an indexed column it would be a filter on every row instead of an index bound. A delay or an `after` instant is rounded up to the millisecond, so a message is never visible early; instants read back are at millisecond precision.

## Two queues, one name

The table kind declares `QUEUE_NAME_DUPLICATE`: two queues naming one `Queue.Table` with one `name` are both reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to be created is refused with `ERR_QUEUE_NAME_DUPLICATE`.

## Runtime requirement

`requires: telo: ">=0.129.0"`: the table kind's rule binds `coReferrers:`, which an older analyzer evaluates unbound and reports as a defect in this module.
