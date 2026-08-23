# Changelog

## 0.9.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.8.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.8.0 - 2026-08-11
### Added
* Schedule.Interval and Schedule.Cron log a firing tick, a tick skipped by a closed 'when' gate, and each re-arm at debug. A skipped tick is otherwise indistinguishable from one that never came due — the schedule simply goes quiet. A failing tick now reports the thrown value as the record's structured error, keeping the type, stack and cause chain that the previous message-only attribute discarded.## 0.7.0 - 2026-08-09
### Added
* metadata.name is now Scheduler, so the module contributes its kinds under the `Scheduler.<Kind>` canonical prefix instead of `scheduler.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.6.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.5.0 - 2026-08-01
### Added
* The controller PURL now carries a `local_path` qualifier naming the TypeScript source its bundle was built from. The kernel builds from that source while the module is a working copy, so a checkout runs with no build step; the qualifier is inert in a published artifact, which ships no sources. Drop the now-redundant `files:` block. A bundled controller joins the artifact payload because `controllers:` names it, so restating it in `files:` was duplication — and a glob over build output at that, which would silently ship a stale `.mjs` left behind by a renamed controller.## 0.4.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.3.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.2.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.2.0 - 2026-07-27
### Added
* Initial release.## 0.1.0
