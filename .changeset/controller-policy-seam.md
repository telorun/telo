---
"@telorun/kernel": patch
---

Internal cleanup ahead of polyglot controller support (see `modules/starlark/plans/polyglot-rust-poc.md`):

- `ControllerRegistry`: deleted the never-fired `registerControllerLoader` cache (gated on `baseDir = null`) and its only consumer (`registerControllerLoader`/`isModuleClass`). The live load path runs through `Telo.Definition.init` calling `ControllerLoader.load(...)`; the parallel registry-internal cache was dead.
- `getController(kind)` now throws `ERR_CONTROLLER_NOT_LOADED` on miss instead of returning a `{ schema: { additionalProperties: false } }` stub. With the `Telo.Definition.init` path live, the stub was unreachable for any kind that has `controllers:` declared, but it silently masked bugs whenever a definition's init had not completed. Callers that want soft semantics use `getControllerOrUndefined(kind)`.
- `kernel.start()`'s register-hook loop now iterates `getControllerKinds()` (kinds with controllers actually loaded) instead of `getKinds()` (all definitions), aligning with the throw-on-miss contract.
- `ControllerLoader.load()` gains an optional `policy?: ControllerPolicy` third parameter as a typed seam. No producers or consumers wired yet — every call site continues to omit it. PR 1 (NapiControllerLoader) wires both ends.

No user-facing behavior change for manifests that load successfully today.
