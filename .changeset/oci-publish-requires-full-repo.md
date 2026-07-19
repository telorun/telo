---
"@telorun/kernel": minor
---

Require a full repository in an OCI publish destination.

`telo publish oci://<host>` used to default the repository to
`<metadata.namespace>/<metadata.name>`. That contradicts identity-is-the-ref:
the repo is a location and the manifest's namespace/name is a label, so the
default was wrong whenever the two differ — and it silently pushed to a
namespace derived from metadata rather than one the publisher owns. Publishing
`std/console` to `oci://ghcr.io` aimed at `ghcr.io/std/console`, under a `std`
org nobody controls.

A host-only destination is now a hard error naming the expected form, so the
repository is always stated explicitly.
