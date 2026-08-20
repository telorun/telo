# Changelog

## 0.11.0 - 2026-08-20
### Added
* table: is now a reference to a declared table rather than a name, and the call signature is typed from it: filters and data are checked against the table's columns and rows come back typed, so a misspelled column fails telo check instead of the query.

## 0.10.0 - 2026-08-09
### Added
* metadata.name is now SqlRepository, so the module contributes its kinds under the `SqlRepository.<Kind>` canonical prefix instead of `sql-repository.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.9.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.8.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.7.1 - 2026-07-27
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
