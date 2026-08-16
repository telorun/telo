# Changelog

## 0.6.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.6.0 - 2026-08-09
### Added
* metadata.name is now KeyValueStoreRedis, so the module contributes its kinds under the `KeyValueStoreRedis.<Kind>` canonical prefix instead of `kv-store-redis.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.5.0 - 2026-08-01
### Added
* The controller PURL now carries a `local_path` qualifier naming the TypeScript source its bundle was built from. The kernel builds from that source while the module is a working copy, so a checkout runs with no build step; the qualifier is inert in a published artifact, which ships no sources. Drop the now-redundant `files:` block. A bundled controller joins the artifact payload because `controllers:` names it, so restating it in `files:` was duplication — and a glob over build output at that, which would silently ship a stale `.mjs` left behind by a renamed controller.## 0.4.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.3.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release. putIfAbsent is SET NX PX; the two compare-and-* operations are generic Lua scripts that compare a revision and know nothing about the value, so every consumer reuses them. No fallback store — a conditional write served from a second, unsynchronised store would let two callers both believe they won. Requires `maxmemory-policy noeviction`.## 0.1.0
