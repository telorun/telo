# Changelog
## 0.11.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.10.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. Kinds that carried no description at all now have one. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.10.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/ai to 0.7.1.## 0.9.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.8.0 - 2026-07-02
### Added
* Update controller @telorun/ai to 0.7.0.## 0.7.0 - 2026-06-13
### Added
* Update controller @telorun/ai to 0.6.0.## 0.6.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.
* Schema examples reference resources with the unified `!ref` form.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/ai to 0.5.0.## 0.4.1 - 2026-06-04
### Fixed
* Ai.Model is now a Telo.Provider (a configured LLM client referenced by the operations) instead of a Telo.Invocable. The completion contract (inputType/outputType) now lives on the Ai.Text and Ai.TextStream operations. Referenced models render as ambient dependencies in the visual editor rather than standalone graph nodes.## 0.4.0
