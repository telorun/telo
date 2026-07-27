# Changelog
## 0.3.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release. In-process backend whose conditional writes are atomic within the single-threaded event loop, so the guarantees hold for ONE process — development and tests only. Overflowing `maxEntries` raises ERR_STORE_FULL as an InvokeError (catchable from a manifest) rather than evicting, since dropping a record would break the non-eviction guarantee.## 0.1.0
