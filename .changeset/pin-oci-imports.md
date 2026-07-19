---
"@telorun/cli": minor
"@telorun/kernel": minor
---

Pin `oci://` imports on publish, restoring the integrity chain for OCI modules.

`fetchManifestHash` recognised only bare registry refs and `http(s)` URLs, so an
`oci://` import fell through to "cannot hash non-remote import" and `telo
publish` skipped it as best-effort-unresolved. Published OCI artifacts therefore
carried unpinned dependencies, and the Merkle chain that makes an importer's
hash transitively cover its dependencies stopped at the first OCI ref — leaving
integrity to rest on registry trust alone, contrary to the inline hash being
authoritative across transports.

Hashing moves onto the `Transport` interface as `manifestHash(ref)`, so each
transport hashes exactly what its own `read()` verifies — registry/HTTP the raw
response bytes, OCI the UTF-8 encoding of the `telo.yaml` extracted from the tar
layer — and a pin written at publish always matches at import. `fetchManifestHash`
is now transport dispatch rather than a scheme chain.

That placement is the actual fix. The bug was the failure mode of a caller-side
`isRegistryRef`/`http(s)`/else chain: a ref whose scheme nobody had added a branch
for degraded silently to best-effort-unresolved. A fourth transport would have
reproduced it identically. Since `manifestHash` is required on the interface, one
cannot now be added without deciding what it hashes.
