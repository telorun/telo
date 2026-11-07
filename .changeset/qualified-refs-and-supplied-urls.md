---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

A resource named like an instance it references through an import alias (`publisherKeys` holding `!ref Schema.publisherKeys`) is no longer reported as depending on itself: a reference written through an alias resolves through that alias's module, never by bare name to a same-named resource of the referring module, so `telo check` and the boot no longer refuse it as a circular dependency, and a step's `invoke:` through an alias reaches the library's resource whatever the referring module declares. A value a parent supplies by name — `App.Instance`'s `variables`, `secrets` and field-by-field `needs` — is decoded from its plain encoding as the same text read from the environment is, so a `Telo.Url` (or any other value type) supplied as text is built instead of refused as "not a Telo.Url".
