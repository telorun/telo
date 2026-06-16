# Changelog
## 0.4.2 - 2026-06-16
### Fixed
* Upgrade imports: http-server@0.12.0, s3@0.6.0, sql@0.9.2, run@0.10.0## 0.4.1 - 2026-06-06
### Fixed
* Compact the MCP server instructions to a ~2KB router. Clients truncate the instructions field at 2048 bytes, so the previous long form was silently cut — agents never received most of it. It now points to https://telo.run/llms.txt, https://telo.run/examples.md, and the build-generated https://telo.run/cel.md (plus telo cel functions / telo cel eval) instead of inlining the full CEL/kind reference.## 0.4.0 - 2026-06-06
### Added
* Document CEL time functions (nowIso(tz)/today(tz)/nowMillis/nowSeconds) and uuidv1/3/4/5/6/7, the absence of ?? (use optional access / orValue), local bindings via cel.bind (CEL has no assignment), and that numeric JSON fields must be numbers not quoted strings. Mention `telo cel functions` / `telo cel eval`.## 0.3.0 - 2026-06-06
### Added
* Expand the MCP server instructions for LLM manifest authoring: a CEL typing section (list/map/ternary homogeneity, null's distinct type, the "prefer YAML shape, scalar !cel leaves" idiom); an "Invoke steps & step results" section documenting the shared { name, invoke, inputs, when } contract and steps.<name>.result used by Application targets, Run.Sequence, and templates; and guidance to split large applications into cohesive Telo.Library directories, with relative imports pointing at the directory containing the library's telo.yaml (no registry publish required).## 0.2.0 - 2026-06-06
### Added
* get_module_manifest accepts 'latest' (the default) to fetch the most recently published version without a prior search_modules lookup.## 0.1.0
