# Changelog
## 0.9.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.8.0 - 2026-07-14
### Added
* Update controller @telorun/http-client to 0.7.0.## 0.7.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.## 0.6.0 - 2026-06-05
### Added
* Update controller @telorun/http-client to 0.6.0.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/http-client to 0.5.0.## 0.4.1
