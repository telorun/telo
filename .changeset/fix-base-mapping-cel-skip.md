---
"@telorun/analyzer": patch
---

Fix a false positive in `base:` mapping validation: a `!cel` value in a `base:`
mapping is a raw tagged sentinel at analysis time (not a compiled value), so
`containsCel` missed it and the sentinel was AJV-checked against the parent
field's type — wrongly raising `BASE_SCHEMA_MISMATCH` ("must be string (got
undefined)") for any CEL mapping (e.g. `baseUrl: !cel "self.url + '/api'"`) when
the defining library was analyzed as a root. CEL leaves in `base:` are now
skipped (their runtime type isn't statically knowable); literal values are still
fully validated.
