# Changelog
## 0.6.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.5.0 - 2026-06-20
### Added
* New `SqlRepo.Update` handler — builds a parameterized `UPDATE <table> SET ... WHERE ...` from the `data` and `filters` maps it is handed. The library now declares its own `Sql` import so its generated SQL handlers resolve regardless of what the consumer imports.## 0.4.0 - 2026-06-20
### Added
* Track the sql driver split — CRUD templates now emit `Sql.Command` (renamed from `Sql.Exec`) and the schema examples reference `SqlSqlite.Connection` / `SqlPostgres.Connection`.## 0.3.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.## 0.2.0 - 2026-06-03
### Added
* Initial publish of the SqlRepository CRUD handler library.## 0.1.0
