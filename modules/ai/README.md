# AI

Model access for Telo — defines the `Ai.Model` and `Ai.ImageModel` abstracts every provider implements and ships ready-to-use buffered, streaming and image consumers.

## Why use this

- **Provider-agnostic** — swap models by changing one resource reference; no controller code touches LLM SDKs directly.
- **Buffered and streaming** — `Ai.Text` returns a complete response; `Ai.TextStream` exposes an async iterable of `StreamPart` records.
- **Text and images** — `Ai.Image` turns a prompt into picture bytes, or reworks pictures you supply, through the same provider you already configured.
- **Composable encoding** — pipe a stream through any `Codec.Encoder` (NDJSON, SSE, plain text, raw bytes) without bespoke serialization.
- **Open for extension** — both model abstracts are `Telo.Abstract`s; any module declaring `extends` is a drop-in provider.
- **Typed contract** — provider input and output are validated by JSON Schema. `Ai.ImageModel` declares its call shape in the manifest, so the kernel enforces it at dispatch and a provider in any language has a contract to implement.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ai.Model` | Abstract contract every LLM provider implements (`invoke` + `stream`). |
| `Ai.Text` | Buffered single-turn LLM call delegating to any `Ai.Model` implementation. |
| `Ai.TextStream` | Streaming counterpart that returns `{ output: Stream<StreamPart> }`. |
| `Ai.Agent` | Tool-use loop over any `Ai.Model` — calls tools, replays results, loops to a final answer. |
| `Ai.ToolProvider` | Abstract contract every agent tool source implements (`listTools` + `callTool`). |
| `Ai.Tools` | Built-in `Ai.ToolProvider`: a static list of tools, each wrapping any `Telo.Invocable`. |
| `Ai.ImageModel` | Abstract contract every image provider implements (`invoke`, declared in the manifest). |
| `Ai.Image` | Buffered image generation and editing delegating to any `Ai.ImageModel` implementation. |

## Example

```yaml
kind: Telo.Application
metadata: { name: my-app, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.10.0
  AiOpenai: oci://ghcr.io/telorun/ai-openai@0.12.0
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: !cel "secrets.openaiApiKey"
---
kind: Ai.Text
metadata: { name: Summarizer }
model: !ref Gpt4o
system: "Summarize concisely."
```

## Reference

- [`Ai.Model`](docs/ai-model.md) — provider contract and implementation walkthrough.
- [`Ai.Text`](docs/ai-text.md) — buffered single-turn call.
- [`Ai.TextStream`](docs/ai-text-stream.md) — streaming consumer.
- [`Ai.Agent`](docs/ai-agent.md) — tool-use loop.
- [`Ai.ToolProvider` / `Ai.Tools`](docs/ai-tool-provider.md) — the tool contract and the static-list provider.
- [`Ai.ImageModel`](docs/ai-image-model.md) — image provider contract and implementation walkthrough.
- [`Ai.Image`](docs/ai-image.md) — buffered generation and editing, intents, refusals.

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

## Tool use

Tool use / function calling is provided by [`Ai.Agent`](docs/ai-agent.md): it advertises tools to the model, executes the ones the model requests, and loops. Tools come from any [`Ai.ToolProvider`](docs/ai-tool-provider.md) — a static [`Ai.Tools`](docs/ai-tool-provider.md#aitools) list, or runtime discovery from an MCP server via [`AiMcp.ToolProvider`](../ai-mcp/README.md). The `Ai.Model` contract carries tools additively (`tools` in, `toolCalls` out, the `tool` message role); `Ai.Text`/`Ai.TextStream` never pass tools and are unaffected.

## What is logged

Every completion kind — `Ai.Text`, `Ai.TextStream`, `Ai.Agent` and `Ai.AgentStream` — logs **token usage and finish reason at `info`**, carrying `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.response.finish_reasons`. Usage is the metered quantity: what a run cost, and why a bill moved. Tracing carries the call's shape but is off unless asked for, and the returned `usage` object is only as visible as whatever the caller does with it.

Both agents report the **aggregate across every turn** plus `ai.agent.steps`, since a per-turn figure would understate an agent that looped eight times. An agent that hits `maxSteps` with `onMaxSteps: return` logs at `warn`: the truncated answer is handed back as an ordinary result — a value, or a terminal `finish` frame — so nothing else marks that it never converged.

A streamed run reports when its terminal part is reached, so a consumer that abandons the stream produces no record — correctly, since no usage was ever reported. One `info` per completion means a 1,000-completion batch is 1,000 records; that is the intended trade for usage being visible by default, and `logging.sampling` bounds it if you need it to.

The record is emitted by the **operation**, not the provider — the same grain the module already normalizes usage on — so a provider published by someone else reports identically without doing anything.

**Prompts, messages and completions are never logged.** They are the user's content, frequently the most sensitive thing in the process, and no threshold is the right place to decide to spill them.

## Out of Scope

- **Multimodal input** — `content` is `string` today; widening to `string | ContentPart[]` is additive when needed.
- **Structured outputs / JSON mode** — not in the core contract; providers may expose via `options`.
- **Streaming agent** — `Ai.Agent` is buffered; a streaming agent is a clean additive kind once the buffered loop is in use.
