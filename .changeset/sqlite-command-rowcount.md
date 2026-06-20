---
"@telorun/sql-sqlite": patch
---

Fix `Sql.Command` reporting `rowCount: 0` for plain INSERT/UPDATE/DELETE under Bun. The `bun:sqlite` driver hardcoded every statement as a reader, so Kysely ran mutations through the row-returning path and never collected `numAffectedRows`. The driver now derives the reader flag from `stmt.columnNames` (empty for non-returning statements), so affected-row counts are reported correctly.
