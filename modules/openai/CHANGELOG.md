# Changelog

## 0.2.0 - 2026-08-30
### Added
* Auth is a credential on an `Http.Client`, not an `apiKey` field. `OpenAI.Model`, `OpenAI.ModelStream`, `OpenAI.ImageModel` and `OpenAI.EmbeddingModel` now reference an `Http.Request` and carry no key of their own, so an account — base URL, credential, timeout, retry — is declared once for every OpenAI kind in an app, and the 401 re-acquire-and-retry that `http-client` owns is inherited rather than re-implemented per provider. A refused request reports the endpoint's own message, since the request controller reads a failed status's body. Image edit, inpaint and variation send their multipart form as bytes under the boundary-bearing content type, so that path is replayable and covered by a hermetic test.
### Fixed
* `model` and `options` are CEL slots again. A `Telo.Provider`'s fields are implicitly `x-telo-eval: compile`; these kinds became `Telo.Invocable` when the model contract was declared, so the two fields that relied on that implicit rule silently stopped being evaluated — `model: !cel "variables.model"` was read as a literal. `apiKey` and `baseUrl` were annotated explicitly and were never affected. Any manifest computing its model id or options from a variable needs this.

## 0.1.0 - 2026-08-29
### Added
* Initial release. Every OpenAI surface under one import: `OpenAI.Model` and `OpenAI.ModelStream` (chat, buffered and streaming), `OpenAI.ImageModel` and `OpenAI.EmbeddingModel`. Supersedes `ai-openai` and `embedding-openai`, which publish deprecated and name this module as their replacement — one module per SYSTEM rather than per endpoint, so moderation, audio, batch and files arrive here as further kinds rather than as a module apiece. Kinds are named by ROLE, as every other backend names them (`Postgres.Connection`, `CacheRedis.Store`): the alias already says which vendor this is, so `OpenAI.OpenaiModel` stuttered it.
