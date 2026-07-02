# Changelog
## 0.8.0 - 2026-07-02
### Added
* Update controller @telorun/ai to 0.7.0.## 0.7.0 - 2026-06-13
### Added
* Update controller @telorun/ai to 0.6.0.## 0.6.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.
* Schema examples reference resources with the unified `!ref` form.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/ai to 0.5.0.## 0.4.1 - 2026-06-04
### Fixed
* Ai.Model is now a Telo.Provider (a configured LLM client referenced by the operations) instead of a Telo.Invocable. The completion contract (inputType/outputType) now lives on the Ai.Text and Ai.TextStream operations. Referenced models render as ambient dependencies in the visual editor rather than standalone graph nodes.## 0.4.0
