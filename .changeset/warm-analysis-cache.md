---
"@telorun/kernel": patch
"@telorun/cli": patch
---

Warm analysis caches at `telo install` time so a prebuilt image boots without re-deriving them.

`kernel.load` now accepts an `analyzeOnly` option that runs the static-analysis pre-flight and persists its caches (the `.validated.json` analysis stamp and the compiled `__validators/` schema cache) but stops before module instantiation, target wiring, and application-env resolution. It also pre-compiles the application-env residual validators (`variables`/`secrets`/`ports`), which the runtime would otherwise recompile on every boot. `telo install` invokes this offline `kernel.load` to bake the caches onto a writable filesystem, so the runtime `load()` on a read-only session rootfs hits the stamp and skips the validation walk instead of failing to persist the caches (EROFS/ENOENT) on every boot.
