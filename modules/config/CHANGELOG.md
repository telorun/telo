# Changelog
## 0.9.0 - 2026-08-09
### Added
* metadata.name is now Config, so the module contributes its kinds under the `Config.<Kind>` canonical prefix instead of `config.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.8.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.7.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.6.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.6.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.5.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.4.1 - 2026-06-28
### Fixed
* Update controller @telorun/config to 0.3.2.## 0.4.0 - 2026-06-07
### Added
* Module `description` so registry search and the MCP `search_modules` tool surface the module's purpose.## 0.3.1
