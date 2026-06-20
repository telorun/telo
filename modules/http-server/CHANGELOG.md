# Changelog
## 0.15.0 - 2026-06-20
### Added
* Update controller @telorun/http-server to 0.14.0.
* Add the `Http.Static` mount — serve a directory of static assets (built SPA, plain HTML, images) on an Http.Server, with a manifest-relative `root`, `spaFallback` for client-side routing, and `maxAge` / `immutable` cache control.## 0.14.0 - 2026-06-20
### Added
* Update controller @telorun/http-server to 0.13.0.## 0.13.0 - 2026-06-18
### Added
* Update controller @telorun/http-server to 0.12.0.## 0.12.1 - 2026-06-16
### Fixed
* Update controller @telorun/http-server to 0.11.1.## 0.12.0 - 2026-06-15
### Added
* Update controller @telorun/http-server to 0.11.0.## 0.11.0 - 2026-06-07
### Added
* Update controller @telorun/http-server to 0.10.0.
* Module `description` and schema `examples:` for registry / MCP discovery (`search_modules` + `get_module_manifest`).
### Fixed
* Validate `Http.Server` mounts strictly — each entry now requires `mount:` and rejects unknown keys, so a misnamed or missing mount reference is caught at `telo check` instead of failing only at boot.## 0.10.0 - 2026-06-07
### Added
* Update controller @telorun/http-server to 0.9.0.## 0.9.0 - 2026-06-06
### Added
* Document the OpenAPI seams on Http.Api routes — request field gains a description pointing at request.schema, and content[mime].schema notes it feeds the generated OpenAPI response. Adds a fully-documented route example (request.schema + response schema with field examples).## 0.8.2 - 2026-06-06
### Fixed
* Clarify the response body field accepts a YAML object (auto-serialized to JSON); don't embed a JSON string.## 0.8.1 - 2026-06-05
### Fixed
* Update controller @telorun/http-server to 0.8.1.## 0.8.0 - 2026-06-05
### Added
* Update controller @telorun/http-server to 0.8.0.## 0.7.0 - 2026-06-04
### Added
* Update controller @telorun/http-server to 0.7.0.## 0.6.1
