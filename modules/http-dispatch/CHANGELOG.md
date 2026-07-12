# Changelog
## 0.7.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.6.0 - 2026-06-07
### Added
* Module `description` so registry search and the MCP `search_modules` tool surface the module's purpose.
* Encoder reference slot uses the unified `!ref` form; the legacy `oneOf` string / `{kind, name}` shapes are removed from the schema.## 0.5.0 - 2026-06-06
### Added
* Clarify that request.schema and returns content[mime].schema drive the generated OpenAPI document (request params/body, response schema), and advise filling fields with type/description/examples.## 0.4.1
