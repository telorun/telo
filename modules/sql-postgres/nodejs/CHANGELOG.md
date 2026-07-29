# @telorun/sql-postgres

## 0.3.0

### Minor Changes

- 6bfc9a1: Backends now own their connection class. `@telorun/sql` exports the `SqlConnection` interface, a `SqlDialect` describing the constructs that differ between databases, and a `SqlConnectionBase` implementing the dialect-neutral half (execution, transactions, template binding, row counts) over kysely. `sql-postgres` and `sql-sqlite` each extend it and supply their own dialect, so `sql` no longer carries a `SqlDriver` union, a SQLite-only `sqlite` handle, or a `driver === "postgres"` branch while building SELECTs — a new database is added without editing the shared module. `SqlConnectionResource` / `createSqlConnection` are replaced by `SqlConnection` / `SqlConnectionBase`, and `SqliteDb` / `SqliteStatement` move to `@telorun/sql-sqlite`, where the driver they describe lives. The bind-placeholder style now has one spelling, `connection.dialect.placeholderStyle` (the top-level mirror is gone), and `connection.kysely` is optional so the contract stays implementable by a driver kysely does not support — `Sql.Migrations`, its only consumer, checks and reports. Documented in two parts: `modules/sql/docs/writing-a-backend.md` states what a backend owes in any language, and `modules/sql/docs/nodejs-backend.md` covers the `@telorun/sql` helper library — kysely is an implementation choice of the Node half, not part of the contract.

  `Sql.Selection` now renders bind placeholders through the connection's dialect instead of always emitting PostgreSQL's `$1`, `$2`. A parameterized `Sql.Selection` against SQLite produced `Too many parameter values were provided` on the Node kernel; it only appeared to work on Bun, whose `bun:sqlite` tolerates `$1` as a named parameter.

  `SqlPostgres.Connection` closes its schema (`additionalProperties: false` on the resource and on `pool`) and bounds the new options at `minimum: 0`, so a misspelled key is a `telo check` error rather than a silently ignored setting — worst of all for `healthCheckMs`, where the app would simply never probe.

  Fix a crash that took down any Postgres app when a connection was lost. `pg` emits `'error'` on an EventEmitter, and `pg-pool` detaches its own listener for the whole window a connection is checked out, so an ordinary disconnect during a query reached an emitter with no listener and Node terminated the process with `Unhandled 'error' event`. `SqlPostgres.Connection` now listens on both paths; the in-flight query is still rejected to its caller, and idle-connection failures are reported at `debug`.

  Add `pool.healthCheckMs` (default 60s) and `pool.maxLifetimeMs` to `SqlPostgres.Connection`. A peer that disappears without closing the socket — an evicted NAT mapping, a blackholed route — reports nothing and is otherwise discovered by the next request, which then fails; the health check probes idle connections on an interval so dead ones are discarded first, and tops the pool back up to `pool.min` (`pg-pool` never opens connections on its own, so a pool left below `min` by a disconnect stayed there until traffic arrived). `maxLifetimeMs` retires connections on schedule as a cause-agnostic backstop. Both map natively onto `pgxpool` and `sqlx` for the Rust and Go ports; the contract is written up in `modules/sql-postgres/docs/connection-lifetime.md`.

### Patch Changes

- Updated dependencies [6bfc9a1]
  - @telorun/sql@0.10.0

## 0.2.1

### Patch Changes

- Updated dependencies [942c176]
  - @telorun/sql@0.9.0

## 0.2.0

### Minor Changes

- 03b8579: Split the `sql` module into a driver-agnostic core plus per-driver backend modules, mirroring `cache` / `cache-memory` / `cache-redis`.

  - `sql` core keeps the `Sql.Connection` abstract and the `Query` / `Command` / `Selection` / `Transaction` / `Migrations` operations, and now depends on `kysely` only. The connection contract is exported (`@telorun/sql` barrel + `@telorun/sql/connection`: `SqlConnectionResource`, `createSqlConnection`, `resolveSqlConnection`, `SqliteDb`) so backends and downstream modules can build/reuse connections.
  - `sql-postgres` (`SqlPostgres.Connection`, owns `pg`) and `sql-sqlite` (`SqlSqlite.Connection`, owns `better-sqlite3` / `bun:sqlite`) provide the concrete connections, each `extends Sql.Connection`.
  - Operations renamed for declarative nouns: `Sql.Exec` → `Sql.Command`, `Sql.Select` → `Sql.Selection`.

  Migration: replace `Sql.PostgresConnection` / `Sql.SqliteConnection` with `SqlPostgres.Connection` / `SqlSqlite.Connection` (add the backend module import), and `Sql.Exec` / `Sql.Select` with `Sql.Command` / `Sql.Selection`. The `sql` bump is kept minor: the module is pre-1.0 and the change is recorded as `Added` rather than forcing a 1.0.0 major.

### Patch Changes

- Updated dependencies [03b8579]
  - @telorun/sql@0.8.0
