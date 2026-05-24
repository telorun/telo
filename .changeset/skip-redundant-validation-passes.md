---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Three further warm-startup optimisations that, layered on top of the manifest-cache write-through, pull warm `telo run hello-world` from ~300 ms to ~215 ms.

- **#1 — analyzer / kernel**: the kernel exposes a `BuiltinControllerContext.isImportValidatedAtLoad(url)` (kernel-internal, not on the public `ResourceContext`) so built-in controllers can ask whether the kernel's load-time analyzer pass already covered a URL. The `Telo.Import` controller now skips its per-import `new StaticAnalyzer().analyze(...)` when the import was part of the entry graph (the common case — every transitive import is). Adds `Loader.canonicalize(url)` and `Kernel.isImportValidatedAtLoad(url)` as the underlying primitives.
- **#9 — analyzer / kernel**: hash-keyed analysis cache. `analyzer.analyze` accepts a new `skipValidation` option that runs only the state-mutating setup (identity / alias / definition registration + `normalizeInlineResources`) and elides every diagnostic-producing pass. The kernel stamps `<entry-dir>/.telo/manifests/.validated.json` with a content signature of the full LoadedGraph (manifest bytes + `@telorun/kernel` + `@telorun/analyzer` versions) after each successful validation; the next load with the same signature skips the per-resource validation walk (≈25 ms warm on hello-world).
- **#4 — kernel**: persistent AJV validator cache. `SchemaValidator` writes compiled validators as standalone CJS modules under `<entry-dir>/.telo/manifests/__validators/<schema-hash>.cjs` and reloads them through a `createRequire` anchored at the kernel package so embedded `require("ajv/...")` / `require("ajv-formats/...")` calls keep resolving. Drops total `ajv.compile` calls during a warm hello-world from 9 to 1 (the remaining one is now lazy — only paid when a `Telo.Definition` document is actually validated). Also removes the unused `validateRuntimeResource` validator (10–15 ms of dead module-init compile time).
