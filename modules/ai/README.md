# AI

LLM access for Telo — defines the `Ai.Model` abstract every provider implements and ships ready-to-use buffered and streaming consumers.

## Why use this

- **Provider-agnostic** — swap models by changing one resource reference; no controller code touches LLM SDKs directly.
- **Buffered and streaming** — `Ai.Text` returns a complete response; `Ai.TextStream` exposes an async iterable of `StreamPart` records.
- **Composable encoding** — pipe a stream through any `Codec.Encoder` (NDJSON, SSE, plain text, raw bytes) without bespoke serialization.
- **Open for extension** — `Ai.Model` is a `Telo.Abstract`; any module declaring `extends: Ai.Model` is a drop-in provider.
- **Typed contract** — provider input (`messages`, `options`) and output (`text`, `usage`, `finishReason`) are validated by JSON Schema.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ai.Model` | Abstract contract every LLM provider implements (`invoke` + `stream`). |
| `Ai.Text` | Buffered single-turn LLM call delegating to any `Ai.Model` implementation. |
| `Ai.TextStream` | Streaming counterpart that returns `{ output: Stream<StreamPart> }`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-app, version: 1.0.0 }
secrets:
  OPENAI_API_KEY: { type: string }
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
kind: Ai.Text
metadata: { name: Summarizer }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
system: "Summarize concisely."
```

## Reference

- [`Ai.Model`](docs/ai-model.md) — provider contract and implementation walkthrough.
- [`Ai.Text`](docs/ai-text.md) — buffered single-turn call.
- [`Ai.TextStream`](docs/ai-text-stream.md) — streaming consumer.

## Provider Contract

Any module declaring `kind: Telo.Definition` with `capability: Telo.Invocable` and `extends: Ai.Model` is a drop-in provider. The runtime contract every provider honours:

```ts
interface AiModelInstance {
  invoke(input: { messages: Message[]; options?: Record<string, unknown> }):
    Promise<{ text: string; usage: Usage; finishReason: FinishReason }>;

  stream(input: { messages: Message[]; options?: Record<string, unknown> }):
    AsyncIterable<StreamPart>;

  snapshot?(): Record<string, unknown>;
}

type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: { message: string; code?: string; data?: unknown } };
```

`Ai.Text` calls `invoke()`; `Ai.TextStream` wraps `stream()` and exposes the iterable as `{ output: Stream<StreamPart> }`. `StreamPart.error` is a plain JSON-serializable object — providers translate native `Error` instances at yield time so generic encoders can frame error parts without bespoke serialization.

## Out of Scope

- **Tool use / function calling** — planned for `Ai.Agent` / `Ai.Worker`, separate kinds.
- **Multimodal input** — `content` is `string` today; widening to `string | ContentPart[]` is additive when needed.
- **Structured outputs / JSON mode** — not in the core contract; providers may expose via `options`.
