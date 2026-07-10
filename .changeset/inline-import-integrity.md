---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Add inline module integrity — remote imports may carry a `#sha256-<base64url>`
fragment (or an `integrity:` sibling on the object form) that pins the fetched
`telo.yaml` bytes. Every source `read()` (registry, HTTP, and the kernel's
on-disk manifest cache) hashes the fetched bytes and fails the load on a
mismatch — a terminal error, never a self-healing cache miss. A canonical
`parseModuleRef`/`splitIntegrity` in the analyzer strips the fragment at every
path-building site so it never pollutes fetch URLs or cache paths.

Bundle modules (`files:` → `module.tar.gz`) pin their payload with a
`filesIntegrity` field on the manifest — a canonical per-file content digest
that `telo publish` writes and `extract` verifies before unpacking. Because the
importer's hash covers the manifest, the payload is pinned transitively.

`telo publish` pins each remote import to its dependency's hash (best-effort:
unresolvable imports are warned, not fatal; `--frozen` makes them hard errors).
`telo upgrade` re-pins on a version change and also pins already-current imports
in place (so a rarely-changing module whose version never moves still gets a
hash), both best-effort.
