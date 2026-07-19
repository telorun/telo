# Changelog
## 0.7.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.6.0 - 2026-07-18
### Added
* Declare `exports.kinds` explicitly, listing every kind the module already exported implicitly, and add a `metadata.description` to every exported kind (and exported resource) so the discovery hub can index them for semantic search. No change to what importers can reference — the module previously relied on the loader treating an absent `exports.kinds` as "export everything", and now states its public kind surface outright.## 0.5.0 - 2026-06-07
### Added
* Module `description` and schema `examples:` for registry / MCP discovery (`search_modules` + `get_module_manifest`).
* `inputType` / `outputType` reference slots use the unified `!ref` form; the legacy `oneOf` string / `{kind, name}` shapes are removed from the schema.## 0.4.1
