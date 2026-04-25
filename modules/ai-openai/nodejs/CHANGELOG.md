# @telorun/ai-openai

## 1.1.0

### Minor Changes

- 80c3c03: Initial release of `@telorun/ai` and `@telorun/ai-openai`.

  `@telorun/ai` ships:

  - `Ai.Model` — `Telo.Abstract` declaring the LLM provider contract (`invoke` + `stream` methods on the runtime instance).
  - `Ai.Completion` — `Telo.Invocable` that delegates single-turn LLM calls to any `Ai.Model` implementation. Owns message-building (prompt shorthand, messages array, system-prompt prepend / override), option layering (manifest → invocation, shallow merge, downstream wins), input exclusivity validation, and output-shape contract enforcement.
  - Internal test fixture (`AiEcho.EchoModel` + `AiEcho.StreamCollector`) under `tests/__fixtures__/ai-echo.yaml` — exercises both the buffered `invoke` and chunked `stream` paths exactly the way external provider packages do, including the alias-form `extends: Ai.Model` resolution.
  - Shared utilities: `redact(fields, obj)` for snapshot redaction; full `AiModelInstance` / `Message` / `Usage` / `FinishReason` / `StreamPart` types under `@telorun/ai/types`.

  `@telorun/ai-openai` ships:

  - `Ai.OpenaiModel` — `Telo.Definition` with `capability: Telo.Invocable, extends: Ai.Model` (canonical alias-form pattern). Implements both methods via Vercel AI SDK (`generateText` for `invoke`, `streamText` for `stream`).
  - Maps Vercel finish reasons into the `Ai.Model` enum (`stop` / `length` / `content-filter` / `error` / `other`).
  - `apiKey` redaction in `snapshot()` so the CEL-visible `resources.<name>` record never carries the secret. Hermetic test asserts the redaction.
  - Manual live integration tests under `tests/__fixtures__/` (env-gated on `OPENAI_API_KEY`); excluded from the default CI run.

  Both packages document the contract, schema, options, and the "how to add a new provider" walkthrough under `docs/`. Wired into the Docusaurus sidebar as a new "AI" group with a "Providers" sub-category.

### Patch Changes

- Updated dependencies [80c3c03]
- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/ai@1.1.0
  - @telorun/sdk@0.5.0
