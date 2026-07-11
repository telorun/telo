---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Add a `Transport` abstraction that owns everything ref-scheme-specific about a
module's lifecycle — manifest read, full-artifact fetch, cache path, version
list, and publish — and ship two implementations behind it: the existing HTTP
registry (`RegistryTransport`) and a new OCI transport (`OciTransport`). The
loader, cache, `telo upgrade`, `telo install`, and `telo publish` no longer
branch on ref shape; they ask the transport registry which transport owns a ref
and delegate, so adding a backend is "implement one interface and register it."

`OciTransport` resolves and publishes `oci://host/repo@version` modules to any
OCI distribution registry (GHCR / ECR / Docker Hub / Harbor) over a hand-rolled
minimal client — pull/push manifest + blob, the `WWW-Authenticate` token
handshake, and the ambient Docker credential chain (`~/.docker/config.json` +
`docker-credential-*`). A module is one artifact: a single tar blob carrying
`telo.yaml` and the `files:` payload, pushed under a standard OCI artifact
manifest (`artifactType: application/vnd.telo.module.v1+tar`).

`telo publish` gains a destination-first positional — `telo publish
<destination?> <paths…>` — whose scheme selects the transport (`oci://` → OCI,
`https://` / bare host → HTTP registry, omitted → the default registry). Bare
`telo publish .` is unchanged. Relative sibling imports are canonicalized
against the destination (OCI: via the destination repo; HTTP: the sibling's
`<namespace>/<name>`), pinned to the sibling's own version, and every derived
ref is verified to resolve at its published location before publishing.

Telo's inline `#sha256-…` hash stays authoritative across transports: the
manifest is verified against it and the payload against the manifest's
`filesIntegrity`, the same Merkle chain regardless of backend. A tamper failure
is a distinct `IntegrityError` (always terminal, never a best-effort skip). The
`isRegistryRef` shape-test now rejects any `scheme://`, so an `oci://…` ref can
never be misrouted to the default registry or a garbage cache path. The tar and
`filesIntegrity` helpers moved from the CLI into the kernel so both transports
share one implementation.
