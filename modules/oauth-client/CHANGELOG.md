# Changelog
## 0.3.0 - 2026-08-01
### Added
* The controller PURL now carries a `local_path` qualifier naming the TypeScript source its bundle was built from. The kernel builds from that source while the module is a working copy, so a checkout runs with no build step; the qualifier is inert in a published artifact, which ships no sources. Drop the now-redundant `files:` block. A bundled controller joins the artifact payload because `controllers:` names it, so restating it in `files:` was duplication — and a glob over build output at that, which would silently ship a stale `.mjs` left behind by a renamed controller.## 0.2.1 - 2026-07-31
### Fixed
* `AuthorizationServer`'s declared `outputType` now includes `issuerParameterSupported` and `timeoutMs`, which it has always returned. The contract forbade them under `additionalProperties: false`; nothing enforced it, so the drift went unseen until the kernel began validating provider results.## 0.2.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.1.0 - 2026-07-29
### Added
* Initial release: obtain and keep delegated access on a user's behalf. Terminal loopback sign-in, browser-served callback, device grant and client credentials; PKCE and issuer verification by default; grants stored in any KvStore.Store and addressed per call; and an Http.Credential implementation that authenticates every request made through a client.## 0.0.0
