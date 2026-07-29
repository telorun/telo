# Changelog
## 0.6.0 - 2026-07-29
### Added
* Update controller @telorun/sql-sqlite to 0.3.0.## 0.5.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.4.2 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.1 - 2026-07-27
### Fixed
* Update controller @telorun/sql-sqlite to 0.2.2.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.3.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.2.1 - 2026-06-20
### Fixed
* Update controller @telorun/sql-sqlite to 0.2.1.
* `Sql.Command` now reports the correct `rowCount` for plain INSERT/UPDATE/DELETE under Bun — the bun:sqlite driver had marked every statement as a reader, so affected-row counts were lost and rowCount was always 0.## 0.2.0 - 2026-06-20
### Added
* Update controller @telorun/sql-sqlite to 0.2.0.## 0.1.0
