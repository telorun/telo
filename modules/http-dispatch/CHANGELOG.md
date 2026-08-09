# Changelog
## 0.11.0 - 2026-08-09
### Added
* metadata.name is now HttpDispatch, so the module contributes its kinds under the `HttpDispatch.<Kind>` canonical prefix instead of `http-dispatch.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.10.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.9.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.
### Fixed
* Update controller @telorun/http-dispatch to 0.4.2.## 0.8.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.8.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.7.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.6.0 - 2026-06-07
### Added
* Module `description` so registry search and the MCP `search_modules` tool surface the module's purpose.
* Encoder reference slot uses the unified `!ref` form; the legacy `oneOf` string / `{kind, name}` shapes are removed from the schema.## 0.5.0 - 2026-06-06
### Added
* Clarify that request.schema and returns content[mime].schema drive the generated OpenAPI document (request params/body, response schema), and advise filling fields with type/description/examples.## 0.4.1
