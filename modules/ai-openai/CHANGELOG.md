# Changelog
## 0.12.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.12.0 - 2026-07-19
### Added
* Update controller @telorun/ai-openai to 0.9.0.## 0.11.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.
### Fixed
* Update controller @telorun/ai-openai to 0.8.1.## 0.10.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.9.0 - 2026-07-02
### Added
* Update controller @telorun/ai-openai to 0.8.0.## 0.8.0 - 2026-06-13
### Added
* Update controller @telorun/ai-openai to 0.7.0.## 0.7.0 - 2026-06-07
### Added
* Schema `examples:` on its kinds so the MCP `get_module_manifest` tool gives authors a copyable template per kind.## 0.6.0 - 2026-06-05
### Added
* Update controller @telorun/ai-openai to 0.6.0.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/ai-openai to 0.5.0.## 0.4.1 - 2026-06-04
### Fixed
* AiOpenai.OpenaiModel is now a Telo.Provider (was Telo.Invocable), matching the Ai.Model provider contract. It is referenced by Ai.Text / Ai.TextStream / Ai.Agent and never invoked directly as a target or step.## 0.4.0
