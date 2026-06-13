---
"@telorun/analyzer": patch
---

Fix a false-positive `INVALID_REFERENCE_FORM` diagnostic on `!ref` slots. The
analyzer's inline-normalization and sentinel-resolution passes mutated their
input manifests in place, rewriting `!ref` sentinels to `{kind, name}`. When a
caller reused the same manifest objects across analyses (notably the editor's
`LoadedFile.manifests` parse cache while a file stayed clean), a later pass saw
the already-rewritten `{kind, name}` and rejected it as an unsupported reference
form. `normalizeInlineResources` now deep-clones its input (treating compiled-CEL
nodes as opaque by-reference leaves), so analysis never mutates caller-owned
manifests.
