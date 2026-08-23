# Changelog

## 0.7.0 - 2026-08-23
### Added
* Controllers return their effects from `init()` / `run()` instead of implementing `teardown()`: each allocation is written beside the inverse that undoes it, and the runtime unwinds them last-in-first-out. A failure part-way through startup now recovers what it already allocated — a bound port releases the kernel hold and unregisters the routes, a connection that fails its health check destroys its pool — and the retry starts from a freshly constructed resource. Declares `requires: telo: '>=0.82.0'`, since an older runtime discards what a controller returns and would allocate nothing.

## 0.6.1 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.5.1 - 2026-08-15
### Fixed
* The AuthorizationServer provider declares `timeoutMs` as `type: integer`, so it crosses that contract as an int64 — and `setTimeout` refuses one, failing every token-endpoint call with a BigInt conversion error. The deadline is read through `integerInput`.## 0.5.0 - 2026-08-11
### Added
* The token lifecycle is logged: a successful refresh at info (carrying the grant key, the new deadline, and whether the server rotated the refresh token — never token material), a grant left with no refresh token at warn, and the refresh trigger plus single-flight claim contention at debug. Which trigger fired matters: a run of server-rejected tokens points at clock skew or too small a refreshSkew rather than normal expiry.## 0.4.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.3.0 - 2026-08-01
### Added
* The controller PURL now carries a `local_path` qualifier naming the TypeScript source its bundle was built from. The kernel builds from that source while the module is a working copy, so a checkout runs with no build step; the qualifier is inert in a published artifact, which ships no sources. Drop the now-redundant `files:` block. A bundled controller joins the artifact payload because `controllers:` names it, so restating it in `files:` was duplication — and a glob over build output at that, which would silently ship a stale `.mjs` left behind by a renamed controller.## 0.2.1 - 2026-07-31
### Fixed
* `AuthorizationServer`'s declared `outputType` now includes `issuerParameterSupported` and `timeoutMs`, which it has always returned. The contract forbade them under `additionalProperties: false`; nothing enforced it, so the drift went unseen until the kernel began validating provider results.## 0.2.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.1.0 - 2026-07-29
### Added
* Initial release: obtain and keep delegated access on a user's behalf. Terminal loopback sign-in, browser-served callback, device grant and client credentials; PKCE and issuer verification by default; grants stored in any KvStore.Store and addressed per call; and an Http.Credential implementation that authenticates every request made through a client.## 0.0.0
