---
description: "Ai.AgentStream: a streaming tool-use loop over any Ai.Model. Same config as Ai.Agent, but emits a Stream of text-delta / tool-call / tool-result / finish events for live SSE."
sidebar_label: Ai.AgentStream
---

# `Ai.AgentStream`

> Examples assume aliases `Ai` (this module), `AiOpenai` (`ai-openai`), `Http` (`http-server`), and `Sse` (`sse-codec`). Substitute if you import under different names.

`Ai.AgentStream` is the streaming counterpart of [`Ai.Agent`](./ai-agent.md): it stands to `Ai.Agent` as [`Ai.TextStream`](./ai-text-stream.md) stands to [`Ai.Text`](./ai-text.md). Same tool-use loop, same configuration — but instead of returning a buffered object, it forwards the run as a `Stream` on `result.output` (the streaming-Invocable convention), so the assistant's text streams token-by-token and every tool call surfaces the moment it happens.

Its schema is identical to `Ai.Agent` — `model`, `system`, `options`, `maxSteps`, `onMaxSteps`, `onToolError`, `toolProviders` — and tool assembly and dispatch are literally shared code, so the two agents never diverge on tool semantics. Only the output shape differs.

## The event stream

`result.output` carries a discriminated union of records (`AgentStreamPart`):

| `type`        | Fields                                                    | Meaning                                                        |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| `text-delta`  | `delta`                                                  | A chunk of assistant text.                                    |
| `tool-call`   | `toolCall: { id, name, arguments }`                      | The model requested a tool.                                   |
| `tool-result` | `toolResult: { toolCallId, name, content, error? }`      | A tool the agent executed. `error: true` on a failed call.    |
| `finish`      | `usage`, `finishReason`                                  | Terminal — accumulated usage across all turns.                |
| `error`       | `error: { message, code? }`                              | Terminal — a model-side error or an aborted run.              |

The stream emits **exactly one** terminal frame (`finish` or `error`). Each model turn internally finishes, but those per-turn finishes are consumed to accumulate `usage` and decide continuation — they are never forwarded, so a downstream consumer never sees a premature terminal.

The `tool-result` shape matches `Ai.Agent`'s `steps[].toolResults` record exactly, so a streaming consumer is never a poorer signal than the buffered trace.

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

event: tool-result
data: {"toolResult":{"toolCallId":"call_0","name":"write_file","content":"{\"bytesWritten\":142}"}}

event: text-delta
data: {"delta":"Added "}

event: text-delta
data: {"delta":"a health endpoint."}

event: finish
data: {"usage":{"promptTokens":220,"completionTokens":48,"totalTokens":268},"finishReason":"stop"}
```

## Cancellation

The loop runs lazily as the consumer pulls the stream, and each tool call is a real side effect. The invoke's cancellation signal is re-checked between turns and before each tool dispatch, and forwarded to every model call — so an abandoned connection stops the loop before the next model turn or tool execution rather than running to completion.

## Terminal & error semantics

These mirror [`Ai.Agent`](./ai-agent.md#maxsteps-and-error-handling), re-expressed as events:

- **`onToolError: feedback`** (default) — a failed tool emits a `tool-result` with `error: true`; the loop continues so the model can react.
- **`onToolError: throw`** — emit a terminal `error` part (the tool error's code, or `ERR_AGENT_TOOL_ERROR`) and end the stream. The exception is converted to an in-band terminal frame rather than escaping, so the one-terminal-frame guarantee holds on the wire.
- **`onMaxSteps: return`** — emit a terminal `finish` with the last turn's `finishReason`.
- **`onMaxSteps: throw`** (default) — emit a terminal `error` part with code `ERR_AGENT_MAX_STEPS`.

## Multimodal tool results

A tool that returns content parts (e.g. an image) flows through as `MessageContent` on the `tool-result` `content`, mirroring `Ai.Agent`. Encoding non-text content parts onto the SSE wire is not yet defined — text/JSON tool results are the supported path today.
