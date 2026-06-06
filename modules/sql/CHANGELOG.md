# Changelog
## 0.7.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.7.0.
* Clarify Sql.Query / Sql.Exec bindings docs — bindings is a regular YAML array; tag each element with its own scalar !cel leaf rather than one inline CEL list literal (avoids homogeneous-typing errors). Adds a schema example.## 0.6.0 - 2026-06-06
### Added
* Update controller @telorun/sql to 0.6.0.
### Fixed
* Document the SQLite single-statement limit on migration/query/exec SQL fields.## 0.5.1
