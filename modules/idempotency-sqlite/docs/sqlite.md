---
description: "The SQLite engine of the SQL idempotency ledger: the table and ledger kinds, what they create, and how concurrent keys and instants behave on SQLite."
sidebar_label: Idempotency — SQLite
---

# `IdempotencySqlite`

> Examples assume this module is imported under alias `Idempotency`, `idempotency-sql` under `IdempotencySql` and `sqlite` under `SQLite`.

What a ledger guarantees, `Once`, fingerprints, retention and the sweep are [`idempotency-sql`'s](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sql/); this page is what is particular to SQLite.

## Kinds

- **`Idempotency.Table`** — a `SQLite.Table` the author writes one field of: `table`, the physical name. List it in the `SQLite.Schema` that creates and migrates it; the module issues no DDL. Several ledgers may share one table.
- **`Idempotency.Ledger`** — `connection` (a `SQLite.Connection`), `schema` (the `SQLite.Schema` listing the table), `table` (an `Idempotency.Table`; a plain `SQLite.Table` is `REFERENCE_KIND_MISMATCH`), `name` and `retention`. It sweeps its expired keys in the background once it has been written to; listing it in `targets:` only starts the first pass earlier.

## What exists in the database

| Object | Definition |
| --- | --- |
| column `ledger_name` | `text`, not null |
| column `idempotency_key` | `text`, not null |
| column `fingerprint` | `text`, nullable |
| column `recorded_at` | fixed-width UTC text (`YYYY-MM-DDTHH:MM:SS.sssZ`), not null |
| index `idempotency_<table>_key` | unique on (`ledger_name`, `idempotency_key`) |
| index `idempotency_<table>_recorded` | on (`ledger_name`, `recorded_at`) |

The layout is internal to `idempotency-sql` and changes only through the schema's migrations.

## Instants

`recorded_at` and the retention cut-off are the database's clock, written through the schema's instant members, to milliseconds.

## Concurrency

SQLite has one writer per database: a second transaction recording the same key waits for the first through the connection's `busy_timeout` (5 s), and an exhausted timeout reaches the caller as a failure. A sweep batch's lock-skipping clause is empty — there is no row lock to skip.

## Two ledgers, one name

The table kind declares `IDEMPOTENCY_LEDGER_NAME_DUPLICATE`: two ledgers naming one `Idempotency.Table` with one `name` are both reported by `telo check` (`REFERRER_RULE_VIOLATED`), and the second to start is refused with `ERR_IDEMPOTENCY_LEDGER_NAME_DUPLICATE`. The rule is declared on this kind rather than once in `idempotency-sql` because a `base:`-form table kind inherits no rule and has one parent, `SQLite.Table` — see [the ledger guide](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sql/).

## Runtime requirement

`requires: telo: ">=0.129.0"`: the table kind's rule binds `coReferrers:`, which an older analyzer evaluates unbound and reports as a defect in this module.
