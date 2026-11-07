# Idempotency — SQL

Make the database effects of a retried or redelivered operation happen **once per key**, by recording the key in the same transaction as the writes it guards. This is the SQL family's shared half: the `Ledger` contract, the `Once` operation and the engine-neutral implementation. Declare a ledger with an engine module — [`idempotency-postgres`](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-postgres/) or [`idempotency-sqlite`](https://hub.telo.run/module/oci/ghcr.io/telorun/idempotency-sqlite/).

## Why use this

- **Committed once per key** — the key is written beside the work's own writes in the caller's transaction. A rollback forgets both; a commit keeps both. A redelivery after the commit finds the key and skips the work.
- **At-least-once in, once out** — a queue delivers a message at least once; a handler that records `delivery.messageId` with `Once` changes the database once per message.
- **Concurrent duplicates wait** — a second call with the same key waits for the first transaction to end, then skips (it committed) or runs (it rolled back). No lock timeout of its own: the caller's deadline bounds the wait.
- **Reused keys are caught** — an optional `fingerprint` describes the work; the same key with a different fingerprint is refused instead of silently skipped.
- **Checked before boot** — a `Once` that is not inside a transaction on its ledger's connection is reported by `telo check`, and two ledgers claiming one name in one table are too.

The guarantee covers writes in the same database transaction. Work that leaves the database — an email, a call to another service — is not rolled back with it; give that work the destination's own idempotency key (`delivery.messageId`) instead.

## Kinds

| Kind | Capability | Purpose |
| --- | --- | --- |
| `IdempotencySql.Ledger` | Service (abstract) | Where keys are recorded: `connection`, `schema`, `table`, `name`, `retention`. Implemented by each engine module's `Ledger`. |
| `IdempotencySql.Once` | Invocable | Runs `invoke` once per key, inside the caller's open transaction on the ledger's connection. Input `{ key, fingerprint?, inputs? }`, output `{ executed, result? }`. |

## Example

```yaml
imports:
  Sql: oci://ghcr.io/telorun/sql@<version>
  Postgres: oci://ghcr.io/telorun/postgres@<version>
  IdempotencySql: oci://ghcr.io/telorun/idempotency-sql@<version>
  Idempotency: oci://ghcr.io/telorun/idempotency-postgres@<version>
targets:
  - !ref appSchema
---
kind: Idempotency.Table
metadata: { name: idempotencyKeys }
table: idempotency_keys
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
tables: [!ref idempotencyKeys, !ref orders]
---
kind: Idempotency.Ledger
metadata: { name: ledger }
connection: !ref db
schema: !ref appSchema
table: !ref idempotencyKeys
name: orders
retention: 168h
---
kind: Sql.Transaction
metadata: { name: placeOrder }
connection: !ref db
inputs:
  messageId: !cel "inputs.messageId"
  order: !cel "inputs.order"
steps:
  kind: Run.Sequence
  steps:
    - name: once
      invoke:
        kind: IdempotencySql.Once
        ledger: !ref ledger
        invoke: !ref insertOrder
      inputs:
        key: !cel "inputs.messageId"
        fingerprint: !cel "inputs.order"
        inputs: { order: !cel "inputs.order" }
```

## Docs

- [The ledger and `Once`](./docs/ledger.md) — guarantees, concurrency, fingerprints, retention and the sweep, what the table holds, the refusals.
