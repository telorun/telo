# @telorun/sql-sqlite

## 0.2.1

### Patch Changes

- 1f16081: Fix `Sql.Command` reporting `rowCount: 0` for plain INSERT/UPDATE/DELETE under Bun. The `bun:sqlite` driver hardcoded every statement as a reader, so Kysely ran mutations through the row-returning path and never collected `numAffectedRows`. The driver now derives the reader flag from `stmt.columnNames` (empty for non-returning statements), so affected-row counts are reported correctly.

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
