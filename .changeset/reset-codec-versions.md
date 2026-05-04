---
"@telorun/codec": patch
"@telorun/ndjson-codec": patch
"@telorun/octet-codec": patch
"@telorun/plain-text-codec": patch
"@telorun/sse-codec": patch
---

Reset versioning for the codec module family to align with the rest of the in-development standard library. Telo itself hasn't shipped 1.0.0, so these modules getting onto a 1.x track was accidental.

The `1.1.0` npm artifacts were unpublished and the manifests + `package.json` files were manually set to `0.2.0`. The Telo registry has the manifests at `0.2.0`; npm now has nothing for these packages. This changeset triggers CI to bump `package.json` from `0.2.0` to `0.2.1` and republish to npm — the `0.2.0` slot is permanently reserved by the prior unpublish (npm forbids slot reuse), but unused.

Affected packages:

- `std/codec` / `@telorun/codec`
- `std/ndjson-codec` / `@telorun/ndjson-codec`
- `std/octet-codec` / `@telorun/octet-codec`
- `std/plain-text-codec` / `@telorun/plain-text-codec`
- `std/sse-codec` / `@telorun/sse-codec`

PURLs in the four codec implementations (`ndjson-codec`, `octet-codec`, `plain-text-codec`, `sse-codec`) were updated alongside the manifest reset to `@telorun/<name>@0.2.0`; the base `codec` module has no PURLs (pure abstract definitions). After this CI run, the next `telo publish` will rewrite those PURLs to `@0.2.1` automatically.

Orphaned versions remain on the Telo registry (no DELETE endpoint yet — see `cli/nodejs/plans/unpublish-command.md`): `std/codec@1.1.0`, `std/ndjson-codec@1.1.0`, `std/octet-codec@1.1.0`, `std/plain-text-codec@1.1.0`, `std/sse-codec@1.1.0`.
