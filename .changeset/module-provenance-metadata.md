---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Declare module provenance in `metadata`, projected into OCI annotations.

`Telo.Application` and `Telo.Library` metadata now accept four optional
descriptive fields: `description`, `repository` (the module's source-code URL),
`license`, and `documentation`. An OCI publish maps them onto the standard
`org.opencontainers.image.*` annotations (`repository` → `source`, `license` →
`licenses`), which is the only metadata channel GHCR exposes — it does not serve
the referrers API. Fields a module does not declare are omitted rather than
written empty. An HTTP registry publish stores the manifest verbatim, so nothing
needs translating there.

These are descriptive, never addressing: nothing resolves, fetches, caches, or
publishes by them, so identity remains the ref. The field is `repository` rather
than `source` because `source:` already means "where to fetch a dependency from"
inside the `imports` map.
