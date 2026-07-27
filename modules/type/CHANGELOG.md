# Changelog
## 0.9.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.8.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.8.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.7.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.6.0 - 2026-06-23
### Added
* Update controller @telorun/type to 0.5.0.## 0.5.0 - 2026-06-20
### Added
* Update controller @telorun/type to 0.4.0.## 0.4.0 - 2026-06-07
### Added
* Module `description` and schema `examples:` for registry / MCP discovery (`search_modules` + `get_module_manifest`).## 0.3.0 - 2026-06-07
### Added
* Update controller @telorun/type to 0.3.0.## 0.2.1
