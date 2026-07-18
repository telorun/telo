# Changelog
## 0.3.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.2.0 - 2026-07-06
### Added
* Update controller @telorun/shell to 0.2.0.## 0.1.0 - 2026-06-30
### Added
* Update controller @telorun/shell to 0.1.0.## 0.0.0
