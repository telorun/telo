# Changelog
## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release. Each conditional write is one statement whose WHERE carries the condition: putIfAbsent is a unique-key INSERT … ON CONFLICT DO UPDATE … WHERE <expired>, compareAndSet/compareAndDelete guard on the stored revision. Supported dialects are stated explicitly (Postgres, SQLite) rather than implying any Sql.Connection works. `createTable` (default true) can be turned off where the table is owned by the app's migrations or the runtime user has no DDL grant. Values round-trip through BigInt-safe JSON.## 0.1.0
