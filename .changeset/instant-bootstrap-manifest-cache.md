---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Make warm `telo run` ~3× faster by populating the local manifest cache automatically and deduplicating loader reads.

- **analyzer**: `Loader.loadFile` now keys a fast path on the request URL, skipping the source `read()` round-trip when the same URL is loaded twice in one kernel lifetime. When the cache has the file in the other compile mode it reparses from cached text instead of re-reading. Previously every duplicate request re-ran the underlying `read()` — a `fetch` for `RegistrySource`, a disk read for `LocalFileSource`.
- **kernel**: `Kernel.load()` retains the full `LoadedGraph` and exposes it via `kernel.getLoadedGraph()` so the CLI can hand it to `writeManifestCache` without re-walking the graph.
- **cli**: `telo run` now writes through to `<entry-dir>/.telo/manifests/` after a successful first load, reusing the same `writeManifestCache` path `telo install` already uses. Subsequent runs hit the local cache and skip the registry round-trip — without requiring an explicit `telo install`. Cache writes are best-effort: read-only filesystems (e.g. baked Docker images) log a warning and continue.
