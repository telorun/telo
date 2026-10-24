---
"@telorun/analyzer": patch
"@telorun/templating": patch
"@telorun/cli": patch
---

`telo check` now refuses two manifests it used to pass and the runtime refused at boot. A resource whose kind is spelled with the name of a module only a dependency imports (`kind: SQLite.Connection` in an application that imports a library which imports `SQLite`) is `UNDEFINED_KIND`, naming the alias to add or, when the module is imported under another alias, the spelling to write; and an alias that resolves is the only module its kind is looked up in. A read of an undeclared resource in a field with no CEL context of its own (`file: !cel "resources.dbFile"` on a connection) is `CEL_UNKNOWN_FIELD`, as it already was inside step bodies; a template's forward views, which nothing publishes, are no longer offered in that message's list of available names. A member read the type checker refuses is reported once, where a step body reported it twice. `telo module manifest oci://host/repo` with no version reads the newest published version instead of asking for a `latest` tag no module publishes.
