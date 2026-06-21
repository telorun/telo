---
"@telorun/analyzer": minor
"@telorun/kernel": patch
"@telorun/cli": patch
"@telorun/assert": patch
---

Inject manifest sources into the `Loader` constructor instead of constructing built-ins inside it.

`new Loader(...)` now takes `(sources: ManifestSource[], options?: { celHandlers? })` — the caller (composition root) decides which concrete sources exist and supplies them. The previous behaviour of self-constructing `HttpSource`/`RegistrySource` (gated by `includeHttpSource`/`includeRegistrySource` flags) and the `extraSources`/`registryUrl` init options are removed. A new exported `defaultSources(registryUrl?)` bundles the browser-safe built-ins (HTTP + registry) for the common case, so consumers compose them explicitly: `new Loader([localFileSource, ...defaultSources(registryUrl)])`.

This removes a dependency-inversion violation: the `Loader` now depends only on the `ManifestSource` abstraction and no longer imports concrete source implementations.
