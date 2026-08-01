# Changelog
## 0.11.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.10.0 - 2026-07-31
### Added
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.9.0 - 2026-07-30
### Added
* Update controller @telorun/mcp-client to 0.6.0.## 0.8.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.7.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. Kinds that carried no description at all now have one. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.7.0 - 2026-07-19
### Added
* Update controller @telorun/mcp-client to 0.5.0.## 0.6.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.5.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.4.1 - 2026-06-28
### Fixed
* Update controller @telorun/mcp-client to 0.4.1.## 0.4.0 - 2026-06-07
### Added
* Update controller @telorun/mcp-client to 0.4.0.## 0.3.1
