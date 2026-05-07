# Telo AI

LLM access for Telo. `@telorun/ai` defines `Ai.Model` — the abstract every provider implements — and ships two ready-to-use consumers: `Ai.Text` for buffered single-turn calls and `Ai.TextStream` for streaming output. Providers (OpenAI, Anthropic, Ollama, third-party) plug in via `Telo.Abstract`, so swapping models is a config change, not a code change.

`@telorun/ai` ships **three kinds**:

| Kind            | Capability       | Purpose                                                                                          |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| `Ai.Model`      | `Telo.Abstract`  | Contract every LLM provider implements (`invoke` + `stream`).                                    |
| `Ai.Text`       | `Telo.Invocable` | Buffered single-turn LLM call delegating to any `Ai.Model` implementation.                       |
| `Ai.TextStream` | `Telo.Invocable` | Streaming counterpart: drives `model.stream()`, returns `{ output: Stream<StreamPart> }`.        |

Concrete provider models live in their own packages so users only install the SDKs they need:

| Package              | Provides                           |
| -------------------- | ---------------------------------- |
| `@telorun/ai-openai` | `Ai.OpenaiModel`                   |
| (third party)        | any `extends: Ai.Model` definition |

---

## Buffered usage — `Ai.Text`

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
kind: Ai.Text
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
    kind: Ai.Text
    name: Summarizer
- name: Use
  inputs:
    summary: "${{ steps.Summarize.result.text }}"
  invoke: ...
```

See [docs/ai-text.md](./docs/ai-text.md) for the full field reference.

---

## Streaming usage — `Ai.TextStream`

`Ai.TextStream.invoke(...)` resolves to `{ output: Stream<StreamPart> }`. The `output` property is marked `x-telo-stream: true` — CEL passes it through by reference, the analyzer treats it as opaque (no member access past `result.output`). Encoding (NDJSON / SSE / plain text / raw bytes) is the consumer's responsibility: pipe `result.output` through a format-codec encoder kind, or iterate the stream directly in a `JS.Script` step.

```yaml
kind: Ai.TextStream
metadata: { name: ChatStream }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
---
# NDJSON encoder from @telorun/ndjson-codec — turns StreamPart records into
# `JSON.stringify(part) + "\n"` byte chunks.
kind: Ndjson.Encoder
metadata: { name: NdjsonEnc }
---
kind: Run.Sequence
metadata: { name: ChatToNdjson }
steps:
  - name: Stream
    inputs: { prompt: "Hello" }
    invoke: { kind: Ai.TextStream, name: ChatStream }
  - name: Encode
    inputs:
      input: "${{ steps.Stream.result.output }}"
    invoke: { kind: Ndjson.Encoder, name: NdjsonEnc }
  # steps.Encode.result.output is now Stream<Uint8Array> — pipe to a transport,
  # or collect via PlainText.Decoder for inspection.
```

Format codecs ship as separate packages (one per format, both directions where applicable):

| Package                       | Provides                                            |
| ----------------------------- | --------------------------------------------------- |
| `@telorun/codec`              | `Codec.Encoder`, `Codec.Decoder` abstracts          |
| `@telorun/plain-text-codec`   | `PlainText.Encoder`, `PlainText.Decoder` (UTF-8)    |
| `@telorun/ndjson-codec`       | `Ndjson.Encoder` (one JSON record per line)         |
| `@telorun/sse-codec`          | `Sse.Encoder` (Server-Sent Events frames)           |
| `@telorun/octet-codec`        | `Octet.Encoder`, `Octet.Decoder` (raw bytes)        |

See [docs/ai-text-stream.md](./docs/ai-text-stream.md) for the full format reference and `JS.Script` iteration patterns.

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

type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: { message: string; code?: string; data?: unknown } };
```

`Ai.Text` calls `invoke()`; `Ai.TextStream` wraps `stream()` and exposes the iterable as `{ output: Stream<StreamPart> }`. Providers expose both methods (using e.g. Vercel AI SDK's `generateText` + `streamText`). `StreamPart.error` is a plain JSON-serializable object — providers translate native `Error` instances at yield time so generic encoders can frame error parts without bespoke serialization.

---

## Out of scope (this module)

- **Tool use / function calling** → planned for `Ai.Agent` / `Ai.Worker`, separate kinds with their own future plans.
- **Multimodal input** → `content` is `string` today; widening to `string | ContentPart[]` is additive when needed.
- **Structured outputs / JSON mode** → not in the core contract; providers may expose via `options`.

## Layout

```text
modules/ai/
├── README.md                ← you are here
├── telo.yaml                ← Telo.Library + Telo.Abstract(Model) + Telo.Definition(Text, TextStream)
├── docs/
│   ├── ai-model.md          ← provider contract & implementation walkthrough
│   ├── ai-text.md           ← Ai.Text field reference (buffered)
│   └── ai-text-stream.md    ← Ai.TextStream field reference (streaming)
├── tests/                   ← hermetic tests using internal AiEcho fixture
│   └── __fixtures__/
│       └── ai-echo.yaml     ← test-only Ai.Model that echoes the last message
└── nodejs/src/
    ├── ai-text-controller.ts
    ├── ai-text-stream-controller.ts
    ├── ai-echo-controller.ts
    ├── stream-collector-controller.ts ← test-support: consumes stream(), collects parts
    ├── redact.ts                     ← shared snapshot helper for providers
    └── types.ts                      ← Message, Usage, FinishReason, StreamPart, AiModelInstance
```
