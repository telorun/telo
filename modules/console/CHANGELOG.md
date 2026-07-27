# Changelog
## 0.12.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.12.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.11.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.10.0 - 2026-06-28
### Added
* Update controller @telorun/console to 0.9.0.## 0.9.0 - 2026-06-07
### Added
* Module `description` and schema `examples:` for registry / MCP discovery (`search_modules` + `get_module_manifest`).## 0.8.0
