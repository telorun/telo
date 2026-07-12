---
"@telorun/cli": minor
---

Add a `telo module` inspection command group — generic, transport-neutral verbs
(the `npm view` / `docker manifest inspect` analog):

- `versions <ref>` — published versions newest-first (`--json`); for a local
  path or direct URL it reports the single declared `metadata.version`.
- `manifest <ref>` — the module's `telo.yaml`, verified against the inline hash
  when pinned.
- `resources <ref>` — the resource instances declared in the manifest (`--json`).
- `kinds <ref>` — the resource kinds the module defines: kind suffix, owning
  module, capability, export status, and description (`--json`). The prefix in a
  `kind:` field is the consumer's own import alias, so a kind's identity is
  reported as the `(module, name)` pair, not a fixed dotted string.

Every verb resolves a ref uniformly across sources — a local path, a direct
`https://` URL, a registry `ns/name[@ver]` ref, or an `oci://host/repo[@tag]`
ref — dispatching through the existing `TransportRegistry` with no scheme
branching. This is the read seam the federated-discovery hub's tracker consumes.
