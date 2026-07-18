---
"@telorun/analyzer": minor
"@telorun/cli": minor
---

Support direct `https://` module refs in the manifest-cache key contract. `analyzer` gains `isHttpsModuleRef` and `urlManifestCacheCoords(ref, version)` — a URL addresses one file whose version lives inside it, so the version is supplied by the caller rather than parsed from the ref; a trailing `telo.yaml` is dropped so the key doesn't duplicate the filename, and refs carrying a query or userinfo are rejected (both would let distinct URLs collide onto one key, or smuggle an authority). `telo module manifest --json` now emits a `cacheKey` for `https://` refs, built from the `metadata.version` the fetched manifest declares.
