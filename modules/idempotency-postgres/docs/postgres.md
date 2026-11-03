---
description: "The PostgreSQL engine of the SQL idempotency ledger: the table and ledger kinds, what they create, and how concurrent keys and instants behave on PostgreSQL."
sidebar_label: Idempotency — PostgreSQL
---

# `IdempotencyPostgres`

> Examples assume this module is imported under alias `Idempotency`, `idempotency-sql` under `IdempotencySql` and `postgres` under `Postgres`.

What a ledger guarantees, `Once`, fingerprints, retention and the sweep are [`idempotency-sql`'s](../../idempotency-sql/docs/ledger.md); this page is what is particular to PostgreSQL.

## Kinds

- **`Idempotency.Table`** — a `Postgres.Table` the author writes one field of: `table`, the physical name. List it in the `Postgres.Schema` that creates and migrates it; the module issues no DDL. Several ledgers may share one table.
- **`Idempotency.Ledger`** — `connection` (a `Postgres.Connection`), `schema` (the `Postgres.Schema` listing the table), `table` (an `Idempotency.Table`; a plain `Postgres.Table` is `REFERENCE_KIND_MISMATCH`), `name` and `retention`. It sweeps its expired keys in the background once it has been written to; listing it in `targets:` only starts the first pass earlier.

## What exists in the database

| Object | Definition |
| --- | --- |
| column `ledger_name` | `text`, not null |
| column `idempotency_key` | `text`, not null |
| column `fingerprint` | `text`, nullable |
| column `recorded_at` | `timestamptz`, not null |
| index `idempotency_<table>_key` | unique on (`ledger_name`, `idempotency_key`) |
| index `idempotency_<table>_recorded` | on (`ledger_name`, `recorded_at`) |

The layout is internal to `idempotency-sql` and changes only through the schema's migrations.

## Instants

`recorded_at` and the retention cut-off are the database's clock, written through the schema's instant members, to microseconds.

## Concurrency

A second transaction recording the same key waits on the ledger's unique index until the first ends, then skips (committed) or records (rolled back). The sweep's batches select with `FOR UPDATE SKIP LOCKED`, so they pass over rows a caller's transaction holds and never wait on one.

## Two ledgers, one name

The table kind declares `IDEMPOTENCY_LEDGER_NAME_DUPLICATE`: two ledgers naming one `Idempotency.Table` with one `name` are both reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to start is refused with `ERR_IDEMPOTENCY_LEDGER_NAME_DUPLICATE`. The rule is declared on this kind rather than once in `idempotency-sql` because a `base:`-form table kind inherits no rule and has one parent, `Postgres.Table` — see [the ledger guide](../../idempotency-sql/docs/ledger.md#refusals).

## Runtime requirement

`requires: telo: ">=0.129.0"`: the table kind's rule binds `coReferrers:`, which an older analyzer evaluates unbound and reports as a defect in this module.
