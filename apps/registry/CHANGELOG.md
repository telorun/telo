# Changelog
## 0.4.0 - 2026-06-06
### Added
* Document CEL time functions (nowIso(tz)/today(tz)/nowMillis/nowSeconds) and uuidv1/3/4/5/6/7, the absence of ?? (use optional access / orValue), local bindings via cel.bind (CEL has no assignment), and that numeric JSON fields must be numbers not quoted strings. Mention `telo cel functions` / `telo cel eval`.## 0.3.0 - 2026-06-06
### Added
* Expand the MCP server instructions for LLM manifest authoring: a CEL typing section (list/map/ternary homogeneity, null's distinct type, the "prefer YAML shape, scalar !cel leaves" idiom); an "Invoke steps & step results" section documenting the shared { name, invoke, inputs, when } contract and steps.<name>.result used by Application targets, Run.Sequence, and templates; and guidance to split large applications into cohesive Telo.Library directories, with relative imports pointing at the directory containing the library's telo.yaml (no registry publish required).## 0.2.0 - 2026-06-06
### Added
* get_module_manifest accepts 'latest' (the default) to fetch the most recently published version without a prior search_modules lookup.## 0.1.0
