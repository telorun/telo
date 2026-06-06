---
"@telorun/analyzer": patch
---

CEL type-checking now descends into `additionalProperties` map values, applying the map's value schema to every entry. Previously CEL inside an open-keyed object map (e.g. a migration's `sql:` body) was typed against an empty schema and went unchecked.
