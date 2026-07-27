# Changelog
## 0.15.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.14.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.14.0 - 2026-07-27
### Added
* Update controller @telorun/run to 0.10.0.## 0.13.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.12.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.11.1 - 2026-06-24
### Fixed
* Update controller @telorun/run to 0.9.1.## 0.11.0 - 2026-06-20
### Added
* Update controller @telorun/run to 0.9.0.## 0.10.0 - 2026-06-14
### Added
* Update controller @telorun/run to 0.8.0.## 0.9.0 - 2026-06-13
### Added
* Update controller @telorun/run to 0.7.0.
* Add Run.Value: a declarative invocable that returns a CEL-evaluated value (or a constant), replacing Js.Script for pure value shaping.## 0.8.0 - 2026-06-07
### Added
* Update controller @telorun/run to 0.6.0.
* Step `invoke` examples reference resources with the unified `!ref` form.## 0.7.0 - 2026-06-06
### Added
* README: bringing up dependencies with a sequence's with:/targets: (a Run.Sequence can start an Http.Server or DB for its steps); targets is not Application-only.## 0.6.0 - 2026-06-06
### Added
* Clarify Run.Sequence inputs/outputs docs — inputs declares the input contract (JSON Schema map, {} = dyn), outputs is the CEL map producing the caller-visible result. Adds a schema example and a "Sequence as an HTTP handler" README example.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/run to 0.5.0.## 0.4.1
