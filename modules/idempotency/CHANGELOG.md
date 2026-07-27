# Changelog
## 0.2.0 - 2026-07-27
### Added
* Initial release.
### Fixed
* Never release a claim after the body has already run. `settle` now sits outside the body's try, so a store failure during settlement can no longer be mistaken for a body failure — which released the key and let the next call re-run the side effect. A lost claim is reported as ERR_CLAIM_LOST instead of a `fresh` that implies a durable record, and an empty key is ERR_INVALID_KEY instead of a fabricated `in-flight` no caller could act on.## 0.1.0
