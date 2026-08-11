# Changelog
## 0.9.0 - 2026-08-11
### Added
* Idempotency.Once logs its outcomes: a replay and an in-flight collision at info, a fresh run and a retryable release at debug, a failed claim heartbeat at warn, and a lost claim at error. Both suppressed paths return successfully, so nothing else marks that the body did not run. The heartbeat is warn rather than debug because a failing renew is a store WRITE failing and the leading indicator of ERR_CLAIM_LOST — a level you must raise in advance is no use once the incident is over. idempotency.key rides on those records.
### Fixed
* Idempotency.Once reports a failed claim heartbeat at debug instead of discarding it. A renew failure is the leading indicator of the ERR_CLAIM_LOST raised later, and by the time the claim is gone the store failure that lost it is no longer visible anywhere.## 0.8.0 - 2026-08-09
### Added
* metadata.name is now Idempotency, so the module contributes its kinds under the `Idempotency.<Kind>` canonical prefix instead of `idempotency.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.7.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.6.0 - 2026-08-01
### Added
* The controller PURL now carries a `local_path` qualifier naming the TypeScript source its bundle was built from. The kernel builds from that source while the module is a working copy, so a checkout runs with no build step; the qualifier is inert in a published artifact, which ships no sources. Drop the now-redundant `files:` block. A bundled controller joins the artifact payload because `controllers:` names it, so restating it in `files:` was duplication — and a glob over build output at that, which would silently ship a stale `.mjs` left behind by a renamed controller.## 0.5.0 - 2026-07-31
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
