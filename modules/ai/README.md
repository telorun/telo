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
| `Ai.Model` | Declared contract for a model called for a complete answer. One bound entry point, `invoke`. |
| `Ai.ModelStream` | The same, delivered as parts as they are generated. A separate abstract — see below. |
| `Ai.Buffered` | Presents an `Ai.ModelStream` as an `Ai.Model`, folding its parts into one answer. |
| `Ai.Text` | Buffered single-turn call over any `Ai.Model`. |
| `Ai.TextStream` | Streaming counterpart over any `Ai.ModelStream`; returns `{ output: Stream<StreamPart> }`. |
| `Ai.Agent` | Tool-use loop over any `Ai.Model` — calls tools, replays results, loops to a final answer. |
| `Ai.AgentStream` | The same loop, streaming its parts as it goes. |
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
  OpenAI: oci://ghcr.io/telorun/openai@0.3.0
  Http: oci://ghcr.io/telorun/http-client@0.22.0
secrets:
  openaiApiKey:
    env: OPENAI_API_KEY
    type: string
---
kind: Http.BearerToken
metadata: { name: openaiKey }
token: !cel "secrets.openaiApiKey"
---
kind: Http.Client
metadata: { name: openaiClient }
baseUrl: https://api.openai.com/v1
credential: !ref openaiKey
---
kind: Http.Request
metadata: { name: openaiRequest }
client: !ref openaiClient
---
kind: OpenAI.ChatModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
request: !ref openaiRequest
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
// Ai.Model — one bound entry point, declared in the manifest and checked by the
// kernel in both directions. Cancellation rides the InvokeContext.
interface AiModelInstance {
  invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult>;
  snapshot?(): Record<string, unknown>;
}

// Ai.ModelStream — the same input, delivered as it is generated.
interface AiModelStreamInstance {
  invoke(input: ModelInvokeInput, ctx?: InvokeContext):
    Promise<{ output: AsyncIterable<StreamPart> }>;
  snapshot?(): Record<string, unknown>;
}

type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "reasoning-delta"; delta: string }
  | { type: "content-part"; part: ContentPart }
  | { type: "provider-state"; providerState: unknown };
```

`Ai.Text` and `Ai.Agent` hold an `Ai.Model`; `Ai.TextStream` and `Ai.AgentStream` hold an `Ai.ModelStream`, whose `invoke()` returns `{ output: Stream<StreamPart> }`. Both entry points are bound and contract-checked by the kernel, so a consumer validates nothing by hand.

`Ai.Buffered` adapts the second to the first: give it an `Ai.ModelStream` and it drives the stream, collects the parts and folds them into one completed answer. That is what makes a provider which only streams usable by `Ai.Text` and `Ai.Agent`. Use a provider's own buffered kind where it has one — collecting a stream to hand back a single answer pays a stream's latency for a buffer's result.

```yaml
kind: Ai.Buffered
metadata: { name: folded }
model: !ref someStreamingProvider
```

A stream **fails by rejecting**: `finish` is the only terminal part, and a mid-stream failure rejects the iteration with a structured error. An error part would have to be remembered by every drainer, and one that forgets truncates silently; a thrown error also reaches `catches:`, a throws union and a `try:` step. Parts already yielded still reach the consumer, and both shipped encoders frame the rejection — carrying its `code` — so a streaming client still sees one terminal frame.

## Tool use

Tool use / function calling is provided by [`Ai.Agent`](docs/ai-agent.md): it advertises tools to the model, executes the ones the model requests, and loops. Tools come from any [`Ai.ToolProvider`](docs/ai-tool-provider.md) — a static [`Ai.Tools`](docs/ai-tool-provider.md#aitools) list, or runtime discovery from an MCP server via [`AiMcp.ToolProvider`](../ai-mcp/README.md). The model contract carries tools additively (`tools` in, `toolCalls` out, the `tool` message role); `Ai.Text`/`Ai.TextStream` never pass tools and are unaffected.

## What is logged

Every completion kind — `Ai.Text`, `Ai.TextStream`, `Ai.Agent` and `Ai.AgentStream` — logs **token usage and finish reason at `info`**, carrying `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.response.finish_reasons`. Usage is the metered quantity: what a run cost, and why a bill moved. Tracing carries the call's shape but is off unless asked for, and the returned `usage` object is only as visible as whatever the caller does with it.

Both agents report the **aggregate across every turn** plus `ai.agent.steps`, since a per-turn figure would understate an agent that looped eight times. An agent that hits `maxSteps` with `onMaxSteps: return` logs at `warn`: the truncated answer is handed back as an ordinary result — a value, or a terminal `finish` frame — so nothing else marks that it never converged.

A streamed run reports when its terminal part is reached, so a consumer that abandons the stream produces no record — correctly, since no usage was ever reported. One `info` per completion means a 1,000-completion batch is 1,000 records; that is the intended trade for usage being visible by default, and `logging.sampling` bounds it if you need it to.

The record is emitted by the **operation**, not the provider — the same grain the module already normalizes usage on — so a provider published by someone else reports identically without doing anything.

**Prompts, messages and completions are never logged.** They are the user's content, frequently the most sensitive thing in the process, and no threshold is the right place to decide to spill them.

## Out of Scope

- **Structured outputs / JSON mode** — `responseFormat` carries the request to a provider that enforces one; nothing here validates the answer against it.
- **Multi-provider routing / failover** — hold two models and choose in the manifest.
- **Prompt templating** — CEL at the call site is the templating.
