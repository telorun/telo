# Changelog

## 0.1.0 - 2026-08-29
### Added
* Initial release. Every OpenAI surface under one import: `OpenAI.Model` and `OpenAI.ModelStream` (chat, buffered and streaming), `OpenAI.ImageModel` and `OpenAI.EmbeddingModel`. Supersedes `ai-openai` and `embedding-openai`, which publish deprecated and name this module as their replacement — one module per SYSTEM rather than per endpoint, so moderation, audio, batch and files arrive here as further kinds rather than as a module apiece. Kinds are named by ROLE, as every other backend names them (`Postgres.Connection`, `CacheRedis.Store`): the alias already says which vendor this is, so `OpenAI.OpenaiModel` stuttered it.
