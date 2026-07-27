# Changelog
## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release. putIfAbsent is SET NX PX; the two compare-and-* operations are generic Lua scripts that compare a revision and know nothing about the value, so every consumer reuses them. No fallback store — a conditional write served from a second, unsynchronised store would let two callers both believe they won. Requires `maxmemory-policy noeviction`.## 0.1.0
