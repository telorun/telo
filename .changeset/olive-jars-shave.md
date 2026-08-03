---
"@telorun/cli": minor
---

`telo publish` no longer requires `metadata.namespace`.

A module identified by `metadata.name` alone now publishes and canonicalizes:
the push target drops to `<registry>/<name>/<version>`, the display label to
`<name>@<version>`, and `canonicalizeRelativeImports` rewrites a relative
`imports:` source to a bare `<name>@<version>` ref. A module that still declares
a namespace is unaffected — the segment is emitted exactly as before.

This is groundwork for retiring the Telo registry in favour of OCI
distribution; `metadata.namespace` existed to namespace registry paths and gate
publish ownership, and is on its way out.
