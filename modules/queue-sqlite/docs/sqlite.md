---
description: "The SQLite engine of the SQL work queue: the table and queue kinds, what they create, and how claiming, waking and instants behave on SQLite."
sidebar_label: Queue — SQLite
---

# `QueueSqlite`

> Examples assume this module is imported under alias `Queue`, `queue-sql` under `QueueSql`, the `queue` module under `Queues` and `sqlite` under `SQLite`.

What a queue guarantees, the transactional enqueue, claiming, groups and retention are [`queue-sql`'s](https://hub.telo.run/module/oci/ghcr.io/telorun/queue-sql/); delivery, retries and dead-lettering are [the queue module's](https://hub.telo.run/module/oci/ghcr.io/telorun/queue/). This page is what is particular to SQLite.

## Kinds

- **`Queue.Table`** — a `SQLite.Table` the author writes one field of: `table`, the physical name. List it in the `SQLite.Schema` that creates and migrates it; the module issues no DDL. Several queues may share one table.
- **`Queue.Queue`** — `connection` (a `SQLite.Connection`), `schema` (the `SQLite.Schema` listing the table), `table` (a `Queue.Table`; a plain `SQLite.Table` is `REFERENCE_KIND_MISMATCH`), `name`, `messageType`, `retention`, and optionally `maxMessageBytes` and `groupBy`.

## What exists in the database

| Object | Definition |
| --- | --- |
| column `seq` | `INTEGER PRIMARY KEY`, auto-incrementing |
| columns `queue_name`, `message_id`, `state`, `body`, `digest` | `text`, not null |
| columns `envelope_generation`, `attempts`, `cancel_requested` | `integer`, not null |
| columns `enqueued_at`, `visible_at` | fixed-width UTC text (`YYYY-MM-DDTHH:MM:SS.sssZ`), not null |
| columns `lease_until`, `settled_at` | the same text, nullable |
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

## Claiming and waking

SQLite has one writer per database: a claim's transaction starts with a write (the purge), so it takes the write lock at once rather than failing to upgrade a read, and a second claimer — in this process or another one on the same file — waits through the connection's `busy_timeout`; an exhausted timeout fails that claim, and the worker backs off and claims again. The lock-skipping clause is empty: there is no row lock to skip.

A SQLite connection cannot notify, so an idle worker polls, backing off from 50 ms to a second between claims.

## Instants

Every instant is the database's clock, written through the schema's instant members, to the millisecond; a delay or an `after` instant is rounded up to the millisecond, so a message is never visible early.

## Two queues, one name

The table kind declares `QUEUE_NAME_DUPLICATE`: two queues naming one `Queue.Table` with one `name` are both reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to be created is refused with `ERR_QUEUE_NAME_DUPLICATE`.

## Runtime requirement

`requires: telo: ">=0.129.0"`: the table kind's rule binds `coReferrers:`, which an older analyzer evaluates unbound and reports as a defect in this module.
