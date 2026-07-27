# Changelog
## 0.7.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.7.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.6.0 - 2026-07-18
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
