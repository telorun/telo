---
"@telorun/kernel": patch
---

Fix `createTypeValidator` crashing with `schema is invalid: data/properties/kind must be object,boolean` when a controller receives an inline type. The analyzer normalizes inline `{kind, schema: {...}}` values into `{kind, name}` refs before Phase 5 injection; the type validator now resolves those refs via the schema registry instead of compiling the ref object as a JSON Schema literal.
