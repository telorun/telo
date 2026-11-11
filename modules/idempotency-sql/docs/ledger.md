---
description: "Transactional idempotency for SQL databases: the Ledger contract, the Once operation, how concurrent and expired keys behave, and what the ledger table holds."
sidebar_label: Idempotency — SQL ledger
---

# `IdempotencySql`

> Examples assume this module is imported under alias `IdempotencySql` and an engine module (`idempotency-postgres` or `idempotency-sqlite`) under `Idempotency`.

## What it guarantees

A **ledger** is a durable record of idempotency keys in a table of the application's own database. **`Once`** runs a body at most once per key, inside a transaction the caller already has open on the ledger's connection:

- **Key absent** — the key is recorded in the caller's transaction and the body runs inside it. Whatever the body writes on that connection commits or rolls back together with the key.
- **Key already committed** — the body is skipped and the call answers `executed: false`. No result is stored, so none is returned.
- **Key being recorded by a concurrent call** — the call waits until that transaction ends, then skips (it committed) or runs (it rolled back). The wait is the database's own on the ledger's unique index; `Once` adds no lock timeout, so the caller's deadline or cancellation bounds it.
- **Body throws** — the error propagates unchanged. The caller's transaction rolls back, the key with it, so a redelivery runs the body again.

So a key is **committed once**, together with the effects it guards. The guarantee is scoped to writes in that same transaction: anything the body does outside the database is not rolled back with it.

`Once` opens no transaction of its own and does not extend `Sql.Transaction`. Put it inside one — a `Sql.Transaction`'s `steps`, or anything that body calls.

## `IdempotencySql.Once`

| Field | Purpose |
| --- | --- |
| `ledger` | The ledger the key is recorded in. |
| `invoke` | The body: any invocable or runnable. It runs inside the caller's transaction, in a region marked `idempotent`. |

| Input | Purpose |
| --- | --- |
| `key` | 1–128 printable ASCII characters (`!` to `~`) naming the logical operation — a message id, a request id. |
| `fingerprint` | Optional, any value: what the work under this key is. The ledger stores a SHA-256 digest of its canonical encoding, so two equal values match whatever order their keys were written in, and a value's type counts (`1` and `"1"` differ). |
| `inputs` | Forwarded to the body when it runs, and held to the body's own input contract (the instance's `inputType`, else its kind's) — a misspelled input is `CONTRACT_INPUTS_MISMATCH` at `telo check`. A body declaring no contract takes any object. The same contract is checked at the `Once`'s own dispatch (`ERR_INPUT_INVALID`), and a field it marks `x-telo-sensitive` is `[redacted]` in the `Once`'s traced inputs. |

| Output | Meaning |
| --- | --- |
| `executed` | Whether this call ran the body. |
| `result` | The body's result, present only when `executed` is true. Typed from the body's output contract — the instance's own `outputType`, else its kind's. |

**Fingerprints.** A key recorded with one fingerprint and called again with a different one is refused with `ERR_IDEMPOTENCY_KEY_CONFLICT` (`data: { key }`, terminal). Only two present fingerprints conflict: a call with none, or a key recorded with none, makes no claim about the work and is a plain duplicate. An expired key records the new fingerprint with the key.

**Errors.** `ERR_IDEMPOTENCY_KEY_CONFLICT` and `ERR_ZONE_REQUIRED` are `Once`'s own; everything the body throws passes through.

## `Ledger`

| Field | Purpose |
| --- | --- |
| `connection` | The connection the table lives on. A `Once` over this ledger must run inside a transaction on it. |
| `schema` | The engine schema that lists the table. It creates and migrates the table and renders its qualified name; the ledger issues no DDL. |
| `table` | The table, declared with the engine module's own `Table` kind. |
| `name` | The ledger's durable identity inside the table. Several ledgers may share one table under different names. It is never derived from the resource's name, so renaming the resource keeps its keys. |
| `retention` | How long a committed key is remembered: a positive `Telo.Duration` (`168h`). Zero or less is refused at `telo check` and again when the ledger is created. |

**Retention is exact at the write.** A key whose `recorded_at` is older than `retention` on the database's own clock reads as absent: recording it again replaces the expired row in the same statement, so the body runs again, whether or not a sweep has removed the row yet. Time is the store's, never a host's — every instant is written and compared through the engine schema's instant members (`currentInstant`, `currentInstantPlus`), to that engine's precision: microseconds on PostgreSQL, milliseconds on SQLite.

**The sweep.** A ledger is a `Telo.Service` that cleans up after itself: a background sweep deletes expired keys in batches of up to 500 rows, each batch its own short transaction that passes over rows another transaction holds (the schema's lock-skipping clause), up to 20 batches per pass. The sweep starts with the ledger's first write — or, when the ledger is a boot target (`targets:`), from its `run()`, which only makes the first pass come earlier. A pass then runs every `retention`, but no more often than once a second and no less often than once a minute. A failed pass is logged as a warning and retried on the next one. `init()` performs no I/O; the sweep never runs inside a caller's transaction, is stopped when the ledger is torn down, and takes no kernel hold, so a ledger never keeps a finished application alive.

## What the table holds

The engine `Table` kinds take one field, `table` (the physical name). Every column and index is the ledger's, declared under `internalColumns`, so no row contract or repository sees them. The layout is internal: it is versioned with this module and changed only through the engine schema's migrations.

| Object | Definition |
| --- | --- |
| column `ledger_name` | text, not null — the ledger's `name` |
| column `idempotency_key` | text, not null — the key |
| column `fingerprint` | text, nullable — the SHA-256 digest of the fingerprint, hex |
| column `recorded_at` | the engine's instant column, not null — when the key was recorded |
| index `idempotency_<table>_key` | unique on (`ledger_name`, `idempotency_key`) — where concurrent callers meet |
| index `idempotency_<table>_recorded` | on (`ledger_name`, `recorded_at`) — the sweep's range |

## Refusals

| Mistake | At `telo check` | At run |
| --- | --- | --- |
| `Once` not inside a transaction on its ledger's connection (none, or one on another connection) | `ZONE_REQUIREMENT_UNSATISFIED` | refused at load; a call the analysis cannot see is `ERR_ZONE_REQUIRED` |
| Two ledgers claiming one `name` in one table | `REFERRER_RULE_VIOLATED` (rule `IDEMPOTENCY_LEDGER_NAME_DUPLICATE`) | `ERR_IDEMPOTENCY_LEDGER_NAME_DUPLICATE` when the second ledger starts |
| A schema instance from an engine module older than the instant and lock-skipping members | — | refused when the ledger is created |
| A `table` not declared with a ledger table kind | `REFERENCE_KIND_MISMATCH` on the engine ledger | refused when the ledger is created |

**Why the duplicate-name rule is declared on each engine's table kind.** The rule is a referrer rule over the ledgers reaching one table (`coReferrers: /table`), and a referrer rule is read off the referenced resource's own kind. That kind is the engine module's `Table`, which must extend its engine's `Table` (`SQLite.Table`, `Postgres.Table`) with `base:` to be listed in that engine's `Schema` — and a kind has one parent, while a `base:`-form kind inherits no rule. So there can be no engine-neutral table kind here for the rule to live on: each engine table kind declares it, with `referrer: IdempotencySql.Ledger`. The runtime twin is shared code — one name registry per table instance, in this module's single scope, which every engine module re-exports.

## Runtime requirement

`requires: telo: ">=0.129.0"`: `Once` asks the kernel for its schema-root zone with the field-less `ctx.requireZone`, and its `result` is typed from the body's contract along `extends`, both first in that release.
