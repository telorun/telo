---
"@telorun/analyzer": patch
---

A template body entry whose `inputType` names a shape (`!ref Shape` or `!ref <Alias>.<Shape>`) now types `inputs` in its CEL exactly as an inline `inputType: { kind: Telo.JsonSchema, schema: … }` does: `telo check` reports a misspelled argument as `CEL_UNKNOWN_FIELD` instead of accepting it (or typing it against the entry kind's own contract).
