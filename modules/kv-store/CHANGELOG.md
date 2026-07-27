# Changelog
## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Update controller @telorun/kv-store to 0.2.0.
* Initial release. The KvStore.Store abstract is a durable, non-evicting key/value store with atomic conditional writes (get / putIfAbsent / compareAndSet / compareAndDelete); a null return is contention, not failure. It differs from Cache.Store by GUARANTEE, not operations. The claim/renew/settle/release protocol is deliberately NOT in the abstract — it lives once in KeyedClaim over those primitives, so no backend reimplements the ownership guard.## 0.1.0
