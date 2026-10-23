---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

`x-telo-value-schema-from` accepts a list of locations — `[/toolProviders/*/provider/contextType, /resolver/contextType]` — each element any form a single location takes (a field name, a JSON Pointer with `*`, or `{ from, member }`). The value must satisfy every type every element reaches, on a configuration slot and inside `inputType` / `outputType` alike, at `telo check` and at dispatch; an element reaching nothing contributes nothing. An empty list, or an element that is no location, is `VALUE_SCHEMA_FROM_INVALID` at the kind and `ERR_VALUE_SCHEMA_FROM_INVALID` when the kernel registers it, naming the element.
