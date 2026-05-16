---
"@telorun/analyzer": patch
---

Fix: schema-from anchors that reference an imported library's alias now resolve correctly when validation runs through `StaticAnalyzer.prepare()` (the kernel-boot path), not just through `analyze()`.

`AnalysisRegistry` now stores `aliasesByModule` (per-library alias scopes for `Telo.Import`s forwarded from inside imported libraries) alongside its existing `aliases` field, and exposes it via `_context()`. `StaticAnalyzer.analyze()` writes into the registry's map instead of a local one, so populations persist across the `analyze() → prepare()` sequence the kernel runs at boot. `prepare()`'s `validateReferences` call now sees both alias scopes and can resolve aliased `x-telo-schema-from` anchors like `"HttpDispatch.Outcomes/$defs/Returns"` (where `HttpDispatch` is an alias declared inside http-server's library, not the consumer's manifest).

Before this fix, the schema-from anchor on `Server.notFoundHandler.returns` / `.catches` (added in the http-dispatch carrier POC) silently worked only when validating http-server's own `telo.yaml`. The same fields in user manifests that imported http-server would have failed with `SCHEMA_FROM_MISSING_PATH: cannot resolve alias 'HttpDispatch.Outcomes'` — but no test exercised that path because no test fixture used `notFoundHandler` with a carrier anchor. The bug surfaced when migrating `Api.routes[].request` to the same anchor pattern.

No behavioural change for manifests that did not use forwarded-library schema-from anchors.
