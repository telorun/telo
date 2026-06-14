---
"@telorun/kernel": minor
---

Lazy controller loading. A `Telo.Definition`'s controller is now imported on the first instantiation of its kind rather than eagerly at definition-init, so a manifest that imports a broad module (e.g. one declaring both a Postgres and a SQLite connection kind) no longer pays the import/eval cost of controllers it never instantiates — cutting cold-start boot latency. Hostability is still verified eagerly at definition-init (the package/bundle must resolve), so a controller that can't load at all still fails fast at boot; only the expensive `import()` and the controller's `register()` hook are deferred. The `ControllerLoading`/`ControllerLoaded` events for a kind now fire on its first instantiation, with the duration measuring just the import. `ControllerLoader` gains a `resolve()` method (resolve without importing) alongside `load()`.
