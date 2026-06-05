# Changelog
## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/ai-openai to 0.5.0.## 0.4.1 - 2026-06-04
### Fixed
* AiOpenai.OpenaiModel is now a Telo.Provider (was Telo.Invocable), matching the Ai.Model provider contract. It is referenced by Ai.Text / Ai.TextStream / Ai.Agent and never invoked directly as a target or step.## 0.4.0
