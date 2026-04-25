---
description: "@telorun/ai — Ai.Model abstract (LLM provider contract) plus Ai.Completion (single-turn invocable). Pluggable providers via Telo.Abstract: OpenAI, Anthropic, Ollama, third-party."
---

# Telo AI

`@telorun/ai` ships **two kinds**:

| Kind            | Capability       | Purpose                                                          |
| --------------- | ---------------- | ---------------------------------------------------------------- |
| `Ai.Model`      | `Telo.Abstract`  | Contract every LLM provider implements (`invoke` + `stream`).    |
| `Ai.Completion` | `Telo.Invocable` | Single-turn LLM call delegating to any `Ai.Model` implementation.|

Concrete provider models live in their own packages so users only install the SDKs they need:

| Package                | Provides              |
| ---------------------- | --------------------- |
| `@telorun/ai-openai`   | `Ai.OpenaiModel`      |
| (third party)          | any `extends: Ai.Model` definition |

---

## Usage

```yaml
kind: Telo.Application
metadata: { name: my-app, version: 1.0.0 }
targets:
  - Workflow
secrets:
  OPENAI_API_KEY:
    type: string
---
kind: Telo.Import
metadata: { name: Ai }
source: pkg:npm/@telorun/ai@^1.0.0
---
kind: Telo.Import
metadata: { name: AiOpenai }
source: pkg:npm/@telorun/ai-openai@^1.0.0
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: "${{ secrets.OPENAI_API_KEY }}"
---
kind: Ai.Completion
metadata: { name: Summarizer }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
system: "Summarize concisely."
```

Invoke from a `Run.Sequence`:

```yaml
- name: Summarize
  inputs:
    prompt: "Summarize: ${{ vars.text }}"
  invoke:
    kind: Ai.Completion
    name: Summarizer
- name: Use
  inputs:
    summary: "${{ steps.Summarize.result.text }}"
  invoke: ...
```

See [docs/ai-completion.md](./docs/ai-completion.md) for full field reference.

---

## Implementing a new provider

`Ai.Model` is an open-for-extension `Telo.Abstract`. Any module declaring `kind: Telo.Definition` with `capability: Telo.Invocable, extends: Ai.Model` is a drop-in provider — no changes to `@telorun/ai` required. Walkthrough: [docs/ai-model.md](./docs/ai-model.md).

The runtime contract every provider honours:

```ts
interface AiModelInstance {
  invoke(input: { messages: Message[]; options?: Record<string, unknown> }):
    Promise<{ text: string; usage: Usage; finishReason: FinishReason }>;

  stream(input: { messages: Message[]; options?: Record<string, unknown> }):
    AsyncIterable<StreamPart>;

  snapshot?(): Record<string, unknown>;
}
```

Providers expose **both methods** from day 1 (using e.g. Vercel AI SDK's `generateText` + `streamText`). Today only `Ai.Completion` calls `invoke()`; a future `Ai.Stream` consumer kind will call `stream()`. That kind ships as a pure additive change — no provider work.

---

## Out of scope (this module)

- **Streaming consumer** → see [plans/model-and-completion.md §12](./plans/model-and-completion.md). Provider-side `stream()` is committed; the consumer kind (Telo.Invocable returning AsyncIterable, Telo.Mount for HTTP SSE, or a new capability) is open design.
- **Tool use / function calling** → planned for `Ai.Agent` / `Ai.Worker`, separate kinds with their own future plans.
- **Multimodal input** → `content` is `string` today; widening to `string | ContentPart[]` is additive when needed.
- **Structured outputs / JSON mode** → not in the core contract; providers may expose via `options`.

## Layout

```
modules/ai/
├── README.md                ← you are here
├── telo.yaml                ← Telo.Library + Telo.Abstract(Model) + Telo.Definition(Completion)
├── docs/
│   ├── ai-model.md          ← provider contract & implementation walkthrough
│   └── ai-completion.md     ← Ai.Completion field reference
├── tests/                   ← hermetic tests using internal AiEcho fixture
│   └── __fixtures__/
│       └── ai-echo.yaml     ← test-only Ai.Model that echoes the last message
└── nodejs/src/
    ├── ai-completion-controller.ts
    ├── ai-echo-controller.ts
    ├── stream-collector-controller.ts ← test-support: consumes stream(), collects parts
    ├── redact.ts                     ← shared snapshot helper for providers
    └── types.ts                      ← Message, Usage, FinishReason, StreamPart, AiModelInstance
```
