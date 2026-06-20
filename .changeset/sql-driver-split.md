---
"@telorun/sql": minor
"@telorun/sql-postgres": minor
"@telorun/sql-sqlite": minor
---

Split the `sql` module into a driver-agnostic core plus per-driver backend modules, mirroring `cache` / `cache-memory` / `cache-redis`.

- `sql` core keeps the `Sql.Connection` abstract and the `Query` / `Command` / `Selection` / `Transaction` / `Migrations` operations, and now depends on `kysely` only. The connection contract is exported (`@telorun/sql` barrel + `@telorun/sql/connection`: `SqlConnectionResource`, `createSqlConnection`, `resolveSqlConnection`, `SqliteDb`) so backends and downstream modules can build/reuse connections.
- `sql-postgres` (`SqlPostgres.Connection`, owns `pg`) and `sql-sqlite` (`SqlSqlite.Connection`, owns `better-sqlite3` / `bun:sqlite`) provide the concrete connections, each `extends Sql.Connection`.
- Operations renamed for declarative nouns: `Sql.Exec` → `Sql.Command`, `Sql.Select` → `Sql.Selection`.

Migration: replace `Sql.PostgresConnection` / `Sql.SqliteConnection` with `SqlPostgres.Connection` / `SqlSqlite.Connection` (add the backend module import), and `Sql.Exec` / `Sql.Select` with `Sql.Command` / `Sql.Selection`. The `sql` bump is kept minor: the module is pre-1.0 and the change is recorded as `Added` rather than forcing a 1.0.0 major.
