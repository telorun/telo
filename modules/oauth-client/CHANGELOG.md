# Changelog
## 0.2.0 - 2026-07-30
### Added
* Publish as a layered artifact: `telo.yaml` in its own blob, one blob per bundled-controller platform selector, one for author-claimed `assets:`, and one for everything else. A consumer fetches only the layers it needs, and a bundled controller now materializes at resolve time — so a cold `telo run` works on the first try instead of failing until a second run had populated the cache.## 0.1.0 - 2026-07-29
### Added
* Initial release: obtain and keep delegated access on a user's behalf. Terminal loopback sign-in, browser-served callback, device grant and client credentials; PKCE and issuer verification by default; grants stored in any KvStore.Store and addressed per call; and an Http.Credential implementation that authenticates every request made through a client.## 0.0.0
