---
"@telorun/analyzer": patch
---

`INVALID_REFERENCE` now says what the slot takes instead of asking for `kind` and `name` fields: an object at a reference slot that is neither a `!ref`, an inline declaration nor a value the slot accepts is reported with each value the slot's schema accepts (by title and type), a `!ref <name>` to a resource of the slot's kinds, and an inline `{ kind: … }` declaration of one, kinds spelled through the reading module's imports.
