# Changelog

## 0.13.0 - 2026-09-09
### Added
* `Http.Api` and `Http.Server` each accept a `catches:` list of their own, so error rendering is declared once per scope instead of restated on every route. A route's own entries are tried first, then its router's, then the server's; a throw no entry claims renders the same `{error: {code, message, data}}` envelope with status 500 that an unmatched throw produced before, so a manifest declaring no scope-level list is unchanged on the wire. Scope entries see `error` and the request's `path` / `method` / `ip`; `query` / `body` / `params` stay with a route's own list, because there is no single route to type them from. A route entry with no `when:` deliberately overrides both outer lists for that route alone.
Crossing the mount boundary is a rethrow rather than a wider mount contract, so the server's list reaches every mount — a third-party one and an `Mcp.HttpEndpoint` included — and `notFoundHandler`, whose own entries are still tried first. `dispatchCatches` therefore no longer invents a response: it reports whether an entry matched and leaves what an unmatched throw means to the caller, which is the only side that knows whether another rung follows. A caller outside this repository that relied on the built-in 500 must render `errorEnvelope(error)` itself when the call returns false.
Coverage moves with it. `UNCOVERED_THROW_CODE` and `UNBOUNDED_UNION_NEEDS_CATCHALL` are now asked once per dispatch site over every list that can render its throws, so a route declaring no `catches:` under a router that covers everything reports nothing — left per-list they would have fired on precisely the manifests this enables. A server-level catch-all consequently satisfies the unbounded-union rule for every mounted route.
This module needs no higher `requires: telo:` floor, verified by execution: a previous runtime reads it with no issues, because both new annotation forms degrade to silence there. An APPLICATION writing a scope-level `catches:` should declare one, though — such a runtime skips the list and so reports its routes as uncovered.
A route's `returns:` and `catches:` now anchor at `HttpDispatch.Outcomes/$defs/*` like every other outcome slot, instead of carrying a fourth inline copy of those shapes. The entry shapes are also CLOSED now, so a misspelled key is reported wherever it is written — a route's copy always rejected one and the shared carrier did not, which made the identical typo an error on a route and silence in a `notFoundHandler`.

## 0.12.0 - 2026-08-21
### Added
* Declare the known media types on the returns/catches `content:` maps as `propertyNames.examples`, so an editor can suggest them. `examples` rather than `enum` keeps the set open — any valid media type is still accepted.

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
