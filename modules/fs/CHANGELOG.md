# Changelog
## 0.4.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.4.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.3.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.2.1 - 2026-07-06
### Fixed
* Quote description strings containing a colon-space inside backticks (e.g. `encoding: base64`) so the registry's strict YAML parser accepts the manifest on publish.## 0.2.0 - 2026-07-06
### Added
* Update controller @telorun/fs to 0.2.0.## 0.1.0 - 2026-06-30
### Added
* Update controller @telorun/fs to 0.1.0.## 0.0.0
