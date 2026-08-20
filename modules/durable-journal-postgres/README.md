# durable-journal-postgres

Stores durable runs in two tables on a PostgreSQL database — one row per run, one row per completed step.

```yaml
kind: Journal.Journal
metadata: { name: runs }
connection: !ref db
```

Point a [`DurableLocal.Workflow`](../durable-local/README.md) at it and its runs survive the process *and* the machine.

## Why a second journal, rather than options on the first

[`durable-journal-file`](../durable-journal-file/README.md) can record and read back. What it cannot do is settle a race between two processes reaching for the same run, and it says so rather than faking it with a lock file. Both of the operations that decide whether a journal works are native here:

- **Claiming** is one conditional `UPDATE`, so two pollers never both take a run whatever the interleaving.
- **Waking** is `LISTEN`/`NOTIFY`, so a delivery reaches a poller in milliseconds instead of at its next interval.

## Exactly-once

This is the part no journal on separate storage can offer. When a durable body's writes run inside an [`Sql.Transaction`](../sql/README.md) opened on **this same connection**, the journal's own `INSERT` lands inside that transaction — so a rollback discards the record along with the effect it described. The step engine reads that attestation and journals the region **step by step** instead of collapsing it to one entry that re-runs whole.

Point the journal at a different database and the attestation is false, the collapse returns, and the region is at-least-once again. That is correct, and it is why the resolution is reported rather than assumed:

```
INFO durable.zone.mode  durable.run=… durable.zone=SQL.Transaction
     durable.zone.attribute=atomic durable.zone.mode=perStep durable.zone.attestation=writesInside
```

`mode=collapsed` rides the same record. A run's own `collapsedRegions` count and `collapseReasons` say the same thing per run, without a log pipeline.

## What it stores

Two tables, named from `table:` (default `telo_durable`):

| Table | One row per | Key |
| --- | --- | --- |
| `<prefix>_runs` | run | `run` |
| `<prefix>_entries` | completed step or decision | `(run, path)` |

The entry key is the primary key, so **first writer wins** is `ON CONFLICT DO NOTHING` exactly — a duplicate append is refused by the database and the stored row is returned instead. Use what came back rather than what you computed; that is what makes two processes racing on one step converge.

Write order is a separate column, because entries are keyed by path and still have to read back in the order they were written.

Creation tolerates a race. `CREATE TABLE IF NOT EXISTS` is **not** concurrency-safe — Postgres checks and then creates, so two instances booting together both pass the check and the loser fails on the catalogue's own unique index (`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`, which reads like corruption and is nothing of the kind). A duplicate-object error *is* the object existing, which is what the statement asked for, so those SQLSTATEs are read as success. Everything else — a missing grant, an unreachable server — still fails the boot.

## Two journals on one database need different prefixes

Each journal treats every run in its own tables as its own, so a shared prefix would make each recover the other's work. Give each its own `table:`.

## Creating the tables

Created on start-up when absent. Turn that off where your own migrations own them, or where the runtime user holds no DDL grant — an unconditional `CREATE` fails the boot outright there:

```yaml
kind: Journal.Journal
metadata: { name: runs }
connection: !ref db
table: onboarding
createTable: false
```

## Waking

Wakes go over a `NOTIFY` channel named from the table prefix (`<prefix>_wake`), overridable with `notifyChannel:`. A [`DurableLocal.Resumer`](../durable-local/README.md) subscribes automatically.

A wake only makes recovery **prompt**; the poller's interval is what makes it **certain**. A missed notification — a dropped connection, a process that was not listening yet — is invisible by nature, so nothing here treats it as the guarantee, and a connection that cannot `LISTEN` simply waits for the next pass.

## Testing it

The tests for this module need a live PostgreSQL, so they live under `tests/integration/` and run separately:

```sh
pnpm run test:integration
```

Connection details come from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME`.
