# Changelog
## 0.11.0 - 2026-07-19
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
