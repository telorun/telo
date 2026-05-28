---
"@telorun/sql": minor
---

**BREAKING:** `Sql.Connection` now derives the database driver from the `connectionString` URL scheme. The `driver` and `file` fields (and the discrete PostgreSQL fields `host`, `port`, `database`, `user`, `password`, `ssl`) have been removed; `connectionString` is now the single required field and its scheme is mandatory.

- PostgreSQL: `postgres://` or `postgresql://`. TLS is configured via the standard libpq `?sslmode=` query parameter (`disable`, `require`, `verify-ca`, `verify-full`) instead of the `ssl` boolean — `?sslmode=require` reproduces the old `ssl: true` relaxed-CA behaviour.
- SQLite: `sqlite:` (`sqlite::memory:`, `sqlite:./data.db`, `sqlite:///abs/path.db`) instead of `driver: sqlite` + `file:`.

Migration: replace `driver: sqlite` + `file: ./x.db` with `connectionString: sqlite:./x.db` (and `file: ":memory:"` with `connectionString: "sqlite::memory:"`); drop `driver: postgres` and move any `ssl: true` into the URL as `?sslmode=require`.
