# Changelog
## 0.5.0 - 2026-07-31
### Added
* `Once` relies on its declared `inputType` to reject a missing or empty `key` instead of re-checking it in the controller. The schema already said so (`required: [key]`, `minLength: 1`) and the kernel now enforces it on every call, so the failure is the ambient `ERR_INPUT_INVALID` — which names the target and the offending value — rather than `ERR_INVALID_KEY`, now removed from the declared union as unreachable.## 0.4.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.3.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release.
### Fixed
* Never release a claim after the body has already run. `settle` now sits outside the body's try, so a store failure during settlement can no longer be mistaken for a body failure — which released the key and let the next call re-run the side effect. A lost claim is reported as ERR_CLAIM_LOST instead of a `fresh` that implies a durable record, and an empty key is ERR_INVALID_KEY instead of a fabricated `in-flight` no caller could act on.## 0.1.0
