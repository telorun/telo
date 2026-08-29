# Changelog

## 0.17.0 - 2026-08-29
### Deprecated
* Merged into the `openai` module, which serves every OpenAI endpoint — chat, images and embeddings — under one import. One module per SYSTEM rather than per endpoint, so moderation, audio, batch and files arrive there as further kinds rather than as a module apiece. The rename rides the release that already breaks every consumer's imports; done later it would be a second break of the same manifests. `telo upgrade` moves a pin within a ref and does not cross a rename, so a consumer edits its `imports:` by hand once.

## 0.15.2 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.15.0 - 2026-08-09
### Added
* AiOpenai.OpenaiImageModel: image generation over the OpenAI images HTTP API, no vendor SDK, on the same key and baseUrl as the chat model. The configured intent picks the endpoint — none goes to /images/generations, edit and inpaint to /images/edits with the mask as its own part, variation to /images/variations — and the kind declares that set as its Intent definition so Ai.Image rejects anything else at telo check time. response_format is sent only to dall-e models, the ones that accept it; an item that comes back as a URL anyway is fetched rather than dropped. Dimensions are read back from the requested size and omitted when it is not pinned; gpt-image-1's token usage is normalized to the provider-neutral quantity. A content refusal is reported as finishReason: content-filter, while every other failure still throws with the provider's message.## 0.14.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.13.0 - 2026-07-27
### Added
* Drop `metadata.namespace`. A module's location is the ref it is published under, never anything it declares about itself, and nothing reads the field any more.## 0.12.1 - 2026-07-27
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
