---
"@telorun/sql": minor
---

`Sql.Migrations` can now own its migrations directly as a keyed `migrations` map — each key is the durable ledger id (and run order / identity). Each value is either a single `statement` or an ordered list of `statements`. This replaces the need for separate `Sql.Migration` provider resources discovered by an implicit module-scope scan.

All pending migrations run in a **single transaction** (PostgreSQL natively via Kysely; SQLite via a transactional-DDL adapter override), so a multi-statement schema change applies atomically or rolls back as a whole.

Backwards compatible: standalone `Sql.Migration` resources are still discovered and merged into the migration set (the map takes precedence on key collisions); `Sql.Migration` is now deprecated in favour of the inline map.
