---
"@telorun/kernel": patch
---

Fix `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at resource init for any kind whose
`Telo.Definition` schema carries an inline `${{ }}` template (commonly inside a
field's `description` / `examples`) and whose controller does not export its own
schema. The loader precompiles such templates into CompiledValue sentinels, so
the schema reaching AJV held a non-string `description` and meta-validation
threw "schema is invalid: …/description must be string" on a cache miss. The
schema validator now canonicalizes CEL/template carriers to their bare source
text before AJV compilation: sentinels collapse to their `source`, and a raw
exact-form `"${{ expr }}"` string is reduced to the same bare `expr`. This both
makes the schema AJV-valid and converges the build-time warm pass (raw strings)
and the runtime (precompiled sentinels) onto one cache key, so the runtime hits
the warmed `__validators` entry instead of recompiling — and failing to persist
on a read-only image — every boot. Surfaced by `std/embedding-openai`
`EmbedOpenai.Model`.
