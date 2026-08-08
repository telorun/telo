---
"@telorun/kernel": minor
"@telorun/sdk": minor
---

`ctx.createSchemaValidator` no longer persists to the on-disk validator cache.

The schema it compiles is author data in a **resource field**, which the build-time warm does not walk — so a disk entry for it could only ever miss and be rewritten on every boot, the last source of EACCES noise on a read-only image. `SchemaValidator.compile` takes a `persist: false` option that drops the disk layer in both directions; the in-memory layers still collapse a repeat compile within the process, but a non-persisted entry is tracked as such, so it can never suppress a later persisting caller's write of the same content. Compiling through the kernel's validator is unchanged, which is what keeps one engine — its formats, its `x-telo-*` keywords, its non-strict mode — for every schema in the process.
