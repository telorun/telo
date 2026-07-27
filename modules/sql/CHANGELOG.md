# Changelog
## 0.15.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.14.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.14.0 - 2026-07-27
### Added
* Update controller @telorun/sql to 0.9.0.## 0.13.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.12.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.11.0 - 2026-06-24
### Added
* Annotate Sql.Selection 'where', 'having', 'limit', and 'offset' as CEL slots (x-telo-context over 'inputs') so the analyzer recognizes them as evaluated fields. The controller already expanded them at invoke time; without the annotation the new CEL_IN_NON_EVAL_FIELD check flagged a !cel there as never evaluated.## 0.10.0 - 2026-06-20
### Added
* Update controller @telorun/sql to 0.8.0.## 0.9.2 - 2026-06-15
### Fixed
* Update controller @telorun/sql to 0.7.2.## 0.9.1 - 2026-06-10
### Fixed
* Update controller @telorun/sql to 0.7.1.## 0.9.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.
* Connection / transaction / type reference slots use the unified `!ref` form; the legacy `oneOf` string / `{kind, name}` shapes are removed from the schema.## 0.8.0 - 2026-06-06
### Added
* README: reusing Sql.Query/Exec/Select as top-level named handlers across routes/sequences, and that Sql.Connection is abstract (instantiate Sql.PostgresConnection / Sql.SqliteConnection).## 0.7.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.7.0.
* Clarify Sql.Query / Sql.Exec bindings docs — bindings is a regular YAML array; tag each element with its own scalar !cel leaf rather than one inline CEL list literal (avoids homogeneous-typing errors). Adds a schema example.## 0.6.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.6.0.
### Fixed
* Document the SQLite single-statement limit on migration/query/exec SQL fields.## 0.5.1
