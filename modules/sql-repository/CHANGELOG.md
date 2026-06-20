# Changelog
## 0.5.0 - 2026-06-20
### Added
* New `SqlRepo.Update` handler — builds a parameterized `UPDATE <table> SET ... WHERE ...` from the `data` and `filters` maps it is handed. The library now declares its own `Sql` import so its generated SQL handlers resolve regardless of what the consumer imports.## 0.4.0 - 2026-06-20
### Added
* Track the sql driver split — CRUD templates now emit `Sql.Command` (renamed from `Sql.Exec`) and the schema examples reference `SqlSqlite.Connection` / `SqlPostgres.Connection`.## 0.3.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.## 0.2.0 - 2026-06-03
### Added
* Initial publish of the SqlRepository CRUD handler library.## 0.1.0
