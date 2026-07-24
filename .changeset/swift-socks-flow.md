---
---

Move the `s3` and `lambda` modules out to the `telorun/connectors` repo (`oci://ghcr.io/telorun/aws/*`). No remaining `@telorun/*` package depends on them, so this needs no release.
