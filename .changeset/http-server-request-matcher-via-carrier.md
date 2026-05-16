---
"@telorun/http-server": patch
---

Migrate `Api.routes[].request` to anchor at the shared `HttpDispatch.Request/$defs/Matcher` carrier instead of inlining the matcher schema (`method` / `path` / `query` / `body` / `headers`). Field-level annotations (`x-telo-topology-role: matcher`) stay on the consuming side; only the value-shape moves to the carrier.

Same pattern as the earlier `Server.notFoundHandler.returns` / `.catches` migration to `HttpDispatch.Outcomes`. Zero behavioural change: the carrier reproduces the inline schema field-for-field, and validation goes through the same AJV path. The win is that `Lambda.HttpApi.routes[].request` (landing next) now shares one structural type-shape with http-server — no duplicated matcher schema across transports.

`HttpDispatch.Request` is required as a dependency — already in `packages/http-dispatch/telo.yaml`'s exports; the existing `Telo.Import` of `HttpDispatch` at the top of `modules/http-server/telo.yaml` covers it.

When http-dispatch evolves the matcher (adds segment annotations, content-encoding hooks, etc.), http-server picks the change up automatically.
