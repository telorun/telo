# Changelog
## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release.
### Fixed
* Never release a claim after the body has already run. `settle` now sits outside the body's try, so a store failure during settlement can no longer be mistaken for a body failure — which released the key and let the next call re-run the side effect. A lost claim is reported as ERR_CLAIM_LOST instead of a `fresh` that implies a durable record, and an empty key is ERR_INVALID_KEY instead of a fabricated `in-flight` no caller could act on.## 0.1.0
