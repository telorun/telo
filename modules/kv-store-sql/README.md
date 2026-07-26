# Durable Store — SQL

`KvStoreSql.Store` — a [`KvStore.Store`](../kv-store/README.md) backed by any `Sql.Connection`.

## Why use this

- **Each conditional write is one statement** — `putIfAbsent` is a unique-key `INSERT … ON CONFLICT DO UPDATE … WHERE <expired>`; `compareAndSet` / `compareAndDelete` guard on the stored revision. The database resolves the race, so there is no client-side read-then-write window.
- **Any engine the `sql` module supports** — it targets the `Sql.Connection` abstract, so Postgres (`sql-postgres`) and SQLite (`sql-sqlite`) both work with no database-specific module.
- **No new infrastructure** — if the app already has a database, it already has a durable store.

## Fields

| Field | Purpose |
| --- | --- |
| `connection` | Reference to the `Sql.Connection` to read and write through. |
| `table` | Table holding the key/value records (default `telo_kv_store`). Use distinct tables to isolate unrelated key spaces sharing one database. |
| `createTable` | Whether to `CREATE TABLE IF NOT EXISTS` on init (default true). Set false when the table is owned by the app's migrations, or the runtime user has no DDL grant. |

## Example

```yaml
kind: SqlPostgres.Connection
metadata: { name: db }
url: !cel "secrets.databaseUrl"
---
kind: KvStoreSql.Store
metadata: { name: store }
connection: !ref db
table: idempotency_keys
---
kind: Idempotency.Once
metadata: { name: chargeOnce }
store: !ref store
claimTtl: "2m"
ttl: "24h"
invoke: !ref chargePayment
```

## Schema

The table is created on init:

```sql
CREATE TABLE IF NOT EXISTS <table> (
  store_key  TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    TEXT NOT NULL,
  expires_at BIGINT NOT NULL
)
```

Expired rows are ignored by every read and overwritten by the next `putIfAbsent`, so the table self-heals. It does not shrink on its own — schedule a periodic `DELETE FROM <table> WHERE expires_at <= …` (a `Schedule.Cron` firing a `Sql.Command`) if the key space is large.

## Clocks

`expires_at` is an epoch-millisecond value supplied by the writing process rather than a database `now()`, which keeps the schema dialect-neutral. That makes it sensitive to clock skew: a host running far ahead can consider another writer's record expired early. Keep hosts on NTP, and size TTLs above both the work's duration and any expected skew.
