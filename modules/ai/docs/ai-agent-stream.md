---
description: "Ai.AgentStream: a streaming tool-use loop over any Ai.ModelStream. Same config as Ai.Agent, but emits a Stream of Ai.AgentStreamPart records — deltas, tool calls with stable ids, per-call usage, tool results, provider state and a terminal finish — for live SSE."
sidebar_label: Ai.AgentStream
---

# `Ai.AgentStream`

> Examples assume aliases `Ai` (this module), `Http` (`http-server`), and `Sse` (`sse-codec`). Substitute if you import under different names.

`Ai.AgentStream` is the streaming counterpart of [`Ai.Agent`](./ai-agent.md): it stands to `Ai.Agent` as [`Ai.TextStream`](./ai-text-stream.md) stands to [`Ai.Text`](./ai-text.md). Same tool-use loop, same configuration — but instead of returning a buffered object, it forwards the run as a `Stream` on `result.output` (the streaming-Invocable convention), so the assistant's text streams token-by-token and every tool call surfaces the moment it happens.

Its schema is identical to `Ai.Agent` — `model`, `system`, `options`, `maxSteps`, `onMaxSteps`, `onToolError`, `toolProviders` — and tool assembly and dispatch are literally shared code, so the two agents never diverge on tool semantics. Only the output shape differs.

## The event stream

`result.output` is a `Stream` of **`Ai.AgentStreamPart`** records — an exported `Telo.JsonSchema`, flat like `Ai.StreamPart`, discriminated by `type`:

| `type`            | Fields                                              | Meaning                                                                 |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `text-delta`      | `delta`                                             | A chunk of assistant text.                                              |
| `reasoning-delta` | `delta`                                             | A chunk of the model's reasoning, when the provider exposes it.         |
| `content-part`    | `part`                                              | A completed content part (an image, a citation, …).                    |
| `tool-call`       | `toolCall: { id, name, arguments }`                 | The model requested a tool. The id is fixed for the rest of the run.   |
| `provider-state`  | `providerState`                                     | Opaque provider state, forwarded as produced (see below).              |
| `step-finish`     | `usage`, `finishReason`                             | One model call ended: that call's usage and finish reason.             |
| `tool-result`     | `toolResult: { toolCallId, name, content, error? }` | A tool the agent executed. `error: true` on a failed call.             |
| `finish`          | `usage`, `finishReason`                             | Terminal — the usage of every call summed.                              |

For a run that calls one tool and then answers, the order is:

```
tool-call(id) · step-finish(u1) · tool-result(id) · text-delta… · step-finish(u2) · finish(u1+u2)
```

- **`step-finish`** closes each model call when its stream ends and **before** that call's tools run, so a consumer can account for spend call by call — including a run that is cancelled or fails later. A call interrupted by a cancellation before its provider's `finish` reports none; one whose `finish` arrived reports it even when the cancellation lands first.
- **`finish`** is the only terminator, and its `usage` is the sum of the `step-finish` usages.
- **Tool call ids** are fixed where the call is first seen: the `tool-call` part, the assistant message replayed to the next model call, and the `tool-result`'s `toolCallId` all carry the same one. A model that supplies none gets a generated `call_<uuid>`, unique across calls, runs and processes, so a stored transcript never has two calls under one id.
- The `tool-result` shape matches `Ai.Agent`'s `steps[].toolResults` record exactly, so a streaming consumer is never a poorer signal than the buffered trace.

A consumer that stores the parts types them by reference — `items: !ref Ai.AgentStreamPart` — and `telo check` then reports a misspelled field (`inputs.records[0].usge`) as `CEL_UNKNOWN_FIELD`.

### Provider state

A provider that keeps its reasoning server-side reports it as `provider-state` parts. The agent **forwards** each one in order and also **replays** the latest to the next model call, so reasoning survives the tool loop. To continue a conversation's reasoning across runs, keep the last `providerState` a run emitted and pass it back as the next run's `providerState` input: it reaches the first model call unchanged. The value is opaque — nothing in `ai` looks inside it.

## Serving over SSE

Pipe `result.output` through an encoder ([`Sse.Encoder`](../../sse-codec/docs/sse-encoder.md), `Ndjson.Encoder`, …) in an [`Http.Api`](../../http-server/docs/http-api.md) `mode: stream` route. The encoder maps each record's `type` to the SSE `event:` and the rest to `data:`.

```yaml
kind: Ai.AgentStream
metadata: { name: Author }
model: !ref Gpt4o
system: |
  You author Telo manifests. Use write_file / edit_file to make changes and
  `run` to validate with `telo check`. Keep replies brief.
maxSteps: 12
toolProviders:
  - provider: !ref WorkspaceTools
---
kind: Sse.Encoder
metadata: { name: SseEnc }
---
kind: Http.Api
metadata: { name: Api }
routes:
  - request:
      path: /chat
      method: POST
      schema:
        body:
          type: object
          required: [prompt]
          properties:
            prompt: { type: string }
    handler: !ref Author
    inputs:
      prompt: !cel "request.body.prompt"
    returns:
      - status: 200
        mode: stream
        content:
          text/event-stream:
            encoder: !ref SseEnc
```

Wire output for a turn that writes one file, then replies:

```
event: tool-call
data: {"toolCall":{"id":"call_0","name":"write_file","arguments":{"path":"health.yaml","content":"..."}}}

event: step-finish
data: {"usage":{"promptTokens":180,"completionTokens":40,"totalTokens":220,"unit":"tokens","total":220},"finishReason":"tool-calls"}

event: tool-result
data: {"toolResult":{"toolCallId":"call_0","name":"write_file","content":"{\"bytesWritten\":142}"}}

event: text-delta
data: {"delta":"Added "}

event: text-delta
data: {"delta":"a health endpoint."}

event: step-finish
data: {"usage":{"promptTokens":220,"completionTokens":8,"totalTokens":228,"unit":"tokens","total":228},"finishReason":"stop"}

event: finish
data: {"usage":{"promptTokens":400,"completionTokens":48,"totalTokens":448,"unit":"tokens","total":448},"finishReason":"stop"}
```

## Invocation inputs

`prompt` xor `messages`, `system` and `options`, as for [`Ai.Agent`](./ai-agent.md#invocation-inputs), plus:

| Field           | Type | Purpose                                                                             |
| --------------- | ---- | ----------------------------------------------------------------------------------- |
| `providerState` | any  | State a previous run's `provider-state` part carried; handed to the first model call. |

## Cancellation

The loop runs lazily as the consumer pulls the stream, and each tool call is a real side effect. The invocation's context is handed to every model call **and to every tool** (a provider passes it on — `Ai.Tools` into the tool's invocation, `AiMcp.ToolProvider` into its `tools/call`), and cancellation is re-checked after every part, between calls and before each tool. A cancelled turn therefore stops the running model call or tool and rejects the stream with `ERR_INVOKE_CANCELLED` — whatever `onToolError` says, since a cancellation is not a tool failure. A durable suspension (`ERR_DURABLE_SUSPENDED`) passes through the same way.

## Terminal & error semantics

These mirror [`Ai.Agent`](./ai-agent.md#maxsteps-and-error-handling). A failure never becomes a record: it **rejects** the iteration, so `catches:`, a throws union and a `try:` step see it. Parts already emitted still reach the consumer, and an encoder frames the rejection for the wire.

- **`onToolError: feedback`** (default) — a failed tool emits a `tool-result` with `error: true`; the loop continues so the model can react.
- **`onToolError: throw`** — the tool's error rejects the iteration.
- **`onMaxSteps: return`** — a terminal `finish` with the last call's `finishReason`.
- **`onMaxSteps: throw`** (default) — rejects with `ERR_AGENT_MAX_STEPS`.
- A model stream that ends without a `finish` part rejects with `ERR_CONTRACT_VIOLATION`.

## Multimodal tool results

A tool that returns content parts (e.g. an image) flows through as `MessageContent` on the `tool-result` `content`, mirroring `Ai.Agent`. Encoding non-text content parts onto the SSE wire is not yet defined — text/JSON tool results are the supported path today.
