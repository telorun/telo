# Changelog
## 0.4.0 - 2026-07-20
### Added
* Updated modules to latest version## 0.3.0 - 2026-07-19
### Added
* Index and serve each module's declared repository and license alongside its description, on /search/modules, /search/resources, /refs, and the search_resources MCP tool.## 0.2.0 - 2026-07-18
### Added
* Index a library's exported singleton instances (`exports.resources`), not just its kinds — a new `module_resources` table, surfaced as `exportedResources` on a module search hit and in the hub-web detail drawer. A public surface is two lists, so a module like std/console (which exports no kinds at all, only `writeLine`/`readLine`) previously showed none of its entry points. Search now also returns only exported kinds — one gated out of `exports.kinds` is not importable, so returning it handed callers a reference they could not write.
* Open self-service registration — POST /register validates a submitted module ref (shape gate, then the telo module versions/manifest CLI verbs), registers it, and indexes its latest version inline so a 200 means it is immediately searchable. Rate-limited per client IP (default 5 per 10m, 429 + Retry-After); the periodic tracker stays on as the reconciler and backfills older versions. The browser-facing form is the new apps/hub-web SPA on hub.telo.run.
* Register a library from a direct https:// manifest URL — a third transport (`url`) alongside registry and OCI, cached at `url/<host>/<path…>/<version>/telo.yaml`. Plaintext http and URLs carrying userinfo or a query are refused. Registration now also requires the manifest's root doc to be a Telo.Library — a Telo.Application cannot be imported, so registering one used to store a record that indexed zero kinds.
### Fixed
* GET /module/versions now returns versions newest-first, matching the `telo module versions` CLI verb it mirrors. It previously returned oldest-first, which contradicted the CLI contract and would make an IDE version completion label the oldest version as "latest".## 0.1.0
