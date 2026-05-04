---
---

Reset versioning for the codec module family to align with the rest of the in-development standard library. Telo itself hasn't shipped 1.0.0, so these modules getting onto a 1.x track was accidental. Reset across all five packages, both manifest `metadata.version` and `package.json` version, `1.1.0` → `0.2.0`:

- `std/codec` / `@telorun/codec`
- `std/ndjson-codec` / `@telorun/ndjson-codec`
- `std/octet-codec` / `@telorun/octet-codec`
- `std/plain-text-codec` / `@telorun/plain-text-codec`
- `std/sse-codec` / `@telorun/sse-codec`

PURLs in the four codec implementations (`ndjson-codec`, `octet-codec`, `plain-text-codec`, `sse-codec`) updated to match (`@telorun/<name>@0.2.0`); the base `codec` module has no PURLs (it's pure abstract definitions). `0.2.0` was chosen as the next clean slot above the only previously-published version (`0.1.0` is unused on npm for these packages, but `0.2.0` cleanly signals "post-reset" without colliding with anything).

Manual cleanup required on npm — one orphaned version per package: `@telorun/codec@1.1.0`, `@telorun/ndjson-codec@1.1.0`, `@telorun/octet-codec@1.1.0`, `@telorun/plain-text-codec@1.1.0`, `@telorun/sse-codec@1.1.0`. (Subject to npm's 72-hour unpublish window — past that, deprecate instead.)

Orphaned versions remain on the Telo registry (no DELETE endpoint yet — see `cli/nodejs/plans/unpublish-command.md`): `std/codec@1.1.0`, `std/ndjson-codec@1.1.0`, `std/octet-codec@1.1.0`, `std/plain-text-codec@1.1.0`, `std/sse-codec@1.1.0`.

Empty changeset because every version field is set manually — there is no automated bump to trigger.
