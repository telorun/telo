---
description: "Ai.TextStream: chunked LLM output as Stream<StreamPart>. Encoding is the consumer's job — pair with a format codec (ndjson, sse, plain-text)."
sidebar_label: Ai.TextStream
---

# `Ai.TextStream`

> Examples below assume this module is imported with `Telo.Import` alias `Ai`. Kind references (`Ai.TextStream`, `Ai.Model`, …) follow that alias.

`Ai.TextStream` is a `Telo.Invocable` that drives `Ai.Model.stream(...)` and exposes the resulting `StreamPart` sequence on `result.output` as a `Stream<StreamPart>`. It is the streaming counterpart of [Ai.Text](./ai-text.md): same `model` reference, same `system`/`options` semantics, different output shape.

`Ai.TextStream` is a thin configured wrapper — it validates inputs, prepends a system prompt, merges options, and forwards the model's iterable. Encoding (NDJSON / SSE / plain text / raw bytes) is the consumer's responsibility: pipe `result.output` through a format-codec encoder kind (`Ndjson.Encoder`, `Sse.Encoder`, `PlainText.Encoder`, `Octet.Encoder`) to turn `StreamPart` records into bytes, or iterate the stream directly in a `JS.Script` step.

```yaml
kind: Telo.Import
metadata: { name: Ai }
source: ../modules/ai
---
kind: Telo.Import
metadata: { name: AiOpenai }
source: ../modules/ai-openai
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o
apiKey: "${{ secrets.OPENAI_API_KEY }}"
---
kind: Ai.TextStream
metadata: { name: ChatStream }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
system: "You are a helpful assistant."
```

---

## Manifest fields

| Field     | Type   | Required | Purpose                                                                                            |
| --------- | ------ | -------- | -------------------------------------------------------------------------------------------------- |
| `model`   | ref    | yes      | Reference to any `Ai.Model` implementation. Typed `x-telo-ref: "std/ai#Model"`.                    |
| `system`  | string | no       | Default system prompt. Runtime `inputs.system` wins when set.                                      |
| `options` | object | no       | Resource-level option defaults. Merged beneath `inputs.options` (downstream wins).                 |

## Invocation inputs

Identical to [Ai.Text](./ai-text.md): `prompt` (shorthand) **or** `messages` (full turns), plus optional `system` / `options` overrides. Same validation rules.

## Output

`Ai.TextStream.invoke(...)` resolves to `{ output: Stream<StreamPart> }`. The `output` property is marked `x-telo-stream: true` in the schema — CEL passes it through by reference, the analyzer treats it as opaque (no member access past `result.output`). Consumers iterate with `for await` or pipe into another stream-typed Invocable.

The provider's `stream()` yields a sequence of tagged `StreamPart` records:

```ts
type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: { message: string; code?: string; data?: unknown } };
```

`StreamPart.error` is a JSON-serializable object (not a native `Error`) so generic encoders can frame it without a bespoke serialization step. Provider controllers translate native errors to this shape at yield time.

## Encoding for the wire

Pipe `result.output` through a format-codec encoder. Each encoder produces `{ output: Stream<Uint8Array> }`; consumers either pipe those bytes to a transport or collect them via `PlainText.Decoder` (UTF-8) or `Octet.Decoder` (raw `Uint8Array`).

### NDJSON

```yaml
kind: Telo.Import
metadata: { name: Ndjson }
source: ../modules/ndjson-codec
---
kind: Ndjson.Encoder
metadata: { name: NdjsonEnc }
---
kind: Run.Sequence
steps:
  - name: Stream
    inputs: { prompt: "Hello" }
    invoke: { kind: Ai.TextStream, name: ChatStream }
  - name: Encode
    inputs:
      input: "${{ steps.Stream.result.output }}"
    invoke: { kind: Ndjson.Encoder, name: NdjsonEnc }
  # steps.Encode.result.output is now Stream<Uint8Array>, one line per StreamPart.
```

```
{"type":"text-delta","delta":"hello"}
{"type":"text-delta","delta":" world"}
{"type":"finish","usage":{"promptTokens":3,"completionTokens":2,"totalTokens":5},"finishReason":"stop"}
```

NDJSON is lossless: every `StreamPart` field travels on the wire, including structured `error` metadata. Pair with `Content-Type: application/x-ndjson`.

### Server-Sent Events

```yaml
kind: Sse.Encoder
metadata: { name: SseEnc }
```

Each `StreamPart` becomes `event: <type>\ndata: <json>\n\n`:

```
event: text-delta
data: {"delta":"hello"}

event: text-delta
data: {"delta":" world"}

event: finish
data: {"usage":{"promptTokens":3,"completionTokens":2,"totalTokens":5},"finishReason":"stop"}

```

Pair with `Content-Type: text/event-stream`. Browser `EventSource` is GET-only; POST chat UIs parse SSE manually via `fetch` + a `ReadableStream` reader.

### Plain text

```yaml
kind: PlainText.Encoder
metadata: { name: PlainEnc }
```

Each `text-delta`'s `delta` becomes UTF-8 bytes. `finish` is silently dropped (plain text has no representation for usage / finishReason). `error` parts throw — the consumer aborts the transport.

```
hello world
```

Pair with `Content-Type: text/plain; charset=utf-8`.

**Loses:** `usage`, `finishReason`, structured error metadata.

## Iterating directly in `JS.Script`

If the consumer is JS, skip the encoder pipeline and iterate `result.output` directly. The `Stream` class is exposed in every `JS.Script`'s scope:

```yaml
kind: JS.Script
metadata: { name: CollectText }
code: |
  async function main({ stream }) {
    let text = "";
    for await (const part of stream) {
      if (part.type === "text-delta") text += part.delta;
    }
    return { text };
  }
```

```yaml
- name: Collect
  inputs:
    stream: "${{ steps.Stream.result.output }}"
  invoke: { kind: JS.Script, name: CollectText }
```

## Cancellation

When the consumer stops iterating (drops the iterator, the HTTP client disconnects, etc.), the iterator's `.return()` propagates back through any encoder in the pipeline to `model.stream()`, and from there to the provider's underlying SDK call. Provider controllers honour the abort signal — failing to do so leaves connections open after the consumer is gone.

## Pairing with `Http.Api`

The HTTP-server integration (single source-Invocable + format-codec response, with `Accept`-based negotiation) is documented in the http-server module. The current minimum: handlers that return `{ output: Stream<...> }` paired with a format encoder.

## What's NOT here

- **Backpressure-aware error catching mid-stream.** Once headers are flushed, errors are surfaced in-band (NDJSON / SSE error frames) — `catches:` only fires for pre-stream throws.
- **Multi-consumer streams.** A single `model.stream()` is consumed by one `Ai.TextStream` invocation; teeing is not supported.
- **Tool use / function calling.** Future `Ai.Agent` / `Ai.Worker` kinds.
