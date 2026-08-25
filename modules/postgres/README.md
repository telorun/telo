# SQL Postgres

`Postgres.Connection` — a PostgreSQL backend for the [`sql`](../sql/README.md) module's `Sql.Connection` abstract. Backed by a `pg` connection pool and Kysely; the `sql` core itself depends on no driver.

Every `sql` operation (`Sql.Query`, `Sql.Command`, `Sql.Selection`, `Sql.Transaction`) and this module's own `Schema` kind references the connection driver-agnostically via `x-telo-ref: Sql.Connection`; this module satisfies that ref.

## Usage

```yaml
imports:
  Sql: oci://ghcr.io/telorun/sql@0.13.0
  Postgres: oci://ghcr.io/telorun/postgres@0.1.0
---
kind: Postgres.Connection
metadata: { name: Db }
connectionString: !cel "secrets.DATABASE_URL"
pool: { min: 2, max: 20, idleTimeoutMs: 10000 }
---
kind: Sql.Query
metadata: { name: GetUser }
connection: !ref Db
inputs:
  sql: !sql "SELECT id, email FROM users WHERE id = ${{ request.params.id }}"
```

## Schema

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `connectionString` | string | yes | `postgres://` / `postgresql://` URL. TLS via the libpq `?sslmode=` parameter (`disable`, `require`, `verify-ca`, `verify-full`). |
| `pool.min` | integer | no | Minimum pooled connections (default 1). |
| `pool.max` | integer | no | Maximum pooled connections (default 10). |
| `pool.idleTimeoutMs` | integer | no | Milliseconds before idle connections close. |
| `pool.connectionTimeoutMs` | integer | no | Milliseconds to wait for a new connection. |
| `pool.maxLifetimeMs` | integer | no | Milliseconds before a connection is retired and replaced. Unlimited when unset. |
| `pool.healthCheckMs` | integer | no | Milliseconds between liveness probes of idle connections (default 60000; `0` disables). |

The connection's bind-placeholder style is fixed to PostgreSQL numbered (`$1`, `$2`, …), so inline `${{ }}` parameters stay dialect-neutral.

## Docs

- [Connection lifetime](docs/connection-lifetime.md) — how a lost connection is detected and replaced, and the contract any implementation of this module must hold. The Node mechanics are in [the implementation notes](nodejs/docs/connection-lifetime.md).

## Declarative schema

`Postgres.Table` declares a table in the full PostgreSQL vocabulary — `varchar`
with a `length`, `citext`, `jsonb`, `uuid`, arrays, identity columns, partial and
method-qualified indexes — and `Postgres.Schema` owns one namespace, bringing it
to what is declared at start-up.

```yaml
kind: Postgres.Table
metadata: { name: users }
table: users
columns:
  id:          { type: uuid, primaryKey: true, defaultExpression: "gen_random_uuid()" }
  email:       { type: citext, nullable: false, unique: true }
  displayName: { type: varchar, length: 64, nullable: false }
  tags:        { type: text, array: true, nullable: false }
indexes:
  usersEmail: { columns: [email], unique: true }
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
schema: app
version: !cel "module.version"
tables: [ !ref users ]
reclaim: { afterVersions: 3, afterDuration: 30d }
```

### Domains, predicates and reference data

A column's `type:` takes a storage class or a `!ref` to a declared enum, and the
schema that owns the type lists it in `enums:`. Named predicates go in `checks:`,
and rows the table is declared to hold go in `seeds:`:

```yaml
kind: Postgres.Enum
metadata: { name: messageRole }
typeName: message_role
values: [system, user, assistant]
---
kind: Postgres.Table
metadata: { name: messages }
table: messages
columns:
  id:           { type: bigint, primaryKey: true, identity: always }
  role:         { type: !ref messageRole, nullable: false }
  balanceCents: { type: bigint, nullable: false, default: 0 }
checks:
  balance_non_negative:
    expression: "balance_cents >= 0"
    # NOT VALID: enforced for new rows now, existing rows scanned on a later
    # pass, so adding it to a large table holds no lock while every row is read.
    validate: deferred
---
kind: Postgres.Schema
metadata: { name: appSchema }
connection: !ref db
schema: app
version: !cel "module.version"
extensions: [citext]
enums: [ !ref messageRole ]
tables: [ !ref messages ]
```

`extensions:` provisions what a storage class needs before any column can use it
— `citext` is unavailable until its extension exists — instead of smuggling
`CREATE EXTENSION` into `migrations:`, which has no release it belongs to.

A table or a type renames with `renamedFrom:`, natively and immediately; a column
still renames expand-contract. See
[Declarative schema](../sql/docs/declarative-schema.md) for the full rules —
what a removal records, what a rename refuses, and why a domain crosses into the
row projection while a bound does not.

The pass needs a **pool of at least two** connections: the advisory lock is held
on a connection of its own while the reconciliation runs on the pool. With
`pool.max: 1` it would wait for the connection the lock is holding, so the pass
proves a second connection is available first and fails with a message naming the
cause rather than hanging at boot.

The namespace is created if absent and **every statement is schema-qualified** —
relying on `search_path` would let a role or session default decide where DDL
lands, with no error when it lands wrong. The pass holds a session-level advisory
lock, so replicas booting together reconcile once.

**Widening is applied, narrowing is refused.** `integer` → `bigint` and
`varchar(64)` → `text` are applied in place; the reverse, and adding `NOT NULL`
to a column that currently holds NULLs, fail naming the table, the column and the
remedy — make the data fit in a `prepare:` entry first.

If a second schema resource — an imported library's, or another application's —
manages tables in the same namespace, give each its own `ledger:` so their
histories stay apart; two on one connection naming the same one are refused.

See [Declarative schema](../sql/docs/declarative-schema.md) for tombstoning,
reclamation, renames and the ledger rule.

## Notifications (`LISTEN` / `NOTIFY`)

A connection can subscribe to a PostgreSQL notification channel and send on one.
This is not part of `Sql.Connection` — that contract is what every backend
implements, and a method only one of them could answer would be a contract
satisfied by throwing — so a consumer reaches it the way `Ai.Model`'s `invoke`
and a connection's own `query()` are reached: structurally, testing for the
method rather than for a type.

```ts
const stop = await connection.listen("jobs_ready", (payload) => wake(payload));
await connection.notify("jobs_ready", jobId);
await stop();
```

The subscription gets its **own connection**, not one from the pool: a listener
holds its connection for as long as it is subscribed, so taking a pooled one
would permanently consume one of `pool.max`. It is opened on first use, so an
application that never subscribes never pays for it, and closed at teardown.

A dropped connection reconnects on a bounded backoff and **replays every
subscription** — `LISTEN` is a property of the connection that carried it, so a
listener that reconnected without replaying would be attached and deaf. The
reconnect is reported rather than raised: a lost notification is a lost
optimisation, and taking an application down over one would be the wrong trade.
Design around that — a notification makes a poller prompt, it does not make it
correct. [`durable-journal-postgres`](../durable-journal-postgres/README.md) is
the worked example.

Failing to subscribe in the first place is *not* swallowed: `listen()` rejects,
because a subscription nobody established is one the caller thinks it has.
