---
"@telorun/sql": minor
---

`Sql.Connection` is now an abstract implemented by two concrete kinds: `Sql.PostgresConnection` (`connectionString` + `pool`) and `Sql.SqliteConnection` (`file`). Consumers keep referencing `std/sql#Connection`; a concrete connection satisfies the ref. Each connection knows its driver's native bind-placeholder style. The generic scheme-based `Sql.Connection` kind is removed — migrate `connectionString: sqlite:…` / `postgres:…` declarations to the matching concrete kind (SQLite uses `file:`).

`Sql.Query` / `Sql.Exec` now support inline parameterized SQL via the `!sql` tag: `sql: !sql "… WHERE id = ${{ x }}"` binds each interpolation as a parameter (dialect-neutral, injection-safe), never splicing it into the text. The `bindings` array remains as an escape hatch for hand-written `?` / `$n` placeholders; combining a `!sql` template with `bindings` is rejected.
