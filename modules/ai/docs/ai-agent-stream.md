---
description: "Ai.AgentStream: a streaming tool-use loop over any Ai.ModelStream. Same config as Ai.Agent, but emits a Stream of Ai.AgentStreamPart records — deltas, tool calls with stable ids, per-call usage, tool results with the tool's own output, every appended message as a record to persist, approval decisions and requests, provider state and a terminal finish marked when the step budget ended the run or it stopped to wait for approval — for live SSE, and traces the run."
sidebar_label: Ai.AgentStream
---

# `Ai.AgentStream`

> Examples assume aliases `Ai` (this module), `Http` (`http-server`), and `Sse` (`sse-codec`). Substitute if you import under different names.

`Ai.AgentStream` is the streaming counterpart of [`Ai.Agent`](./ai-agent.md): it stands to `Ai.Agent` as [`Ai.TextStream`](./ai-text-stream.md) stands to [`Ai.Text`](./ai-text.md). Same tool-use loop, same configuration — but instead of returning a buffered object, it forwards the run as a `Stream` on `result.output` (the streaming-Invocable convention), so the assistant's text streams token-by-token and every tool call surfaces the moment it happens.

Its schema is identical to `Ai.Agent` — `model`, `system`, `options`, `maxSteps`, `onMaxSteps`, `conclusionPrompt`, `onToolError`, `maxToolResultBytes`, `maxParallelTools`, `toolProviders`, `approver` — and tool assembly, dispatch, approval and the recorded conversation are literally shared code, so the two agents never diverge on tool semantics. Only the output shape differs.

## The event stream

`result.output` is a `Stream` of **`Ai.AgentStreamPart`** records — an exported `Telo.JsonSchema`, flat like `Ai.StreamPart`, discriminated by `type`:

| `type`            | Fields                                              | Meaning                                                                 |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `text-delta`      | `delta`                                             | A chunk of assistant text.                                              |
| `reasoning-delta` | `delta`                                             | A chunk of the model's reasoning, when the provider exposes it.         |
| `content-part`    | `part`                                              | A completed content part (an image, a citation, …).                    |
| `tool-call-delta` | `toolCallId`, `toolName`, `delta`                   | A fragment of a tool call's arguments, as the model writes them. Advisory — see [Tool-call argument deltas](#tool-call-argument-deltas). |
| `tool-call`       | `toolCall: { id, name, arguments }`                 | The model requested a tool. The id is fixed for the rest of the run.   |
| `provider-state`  | `providerState`                                     | Opaque provider state, forwarded as produced (see below).              |
| `step-finish`     | `usage`, `finishReason`                             | One model call ended: that call's usage and finish reason.             |
| `tool-result`     | `toolResult: { toolCallId, name, content, output?, error?, denied? }` | A tool the agent executed: `content` is what the model was told, `output` what the tool returned. `error: true` on a failed call; `denied: true` on a call that was decided against and never ran. |
| `message`         | `message`                                           | A message the run appended to the conversation — see [The `message` part is the record](#the-message-part-is-the-record). |
| `tool-approval-decision` | `approvalDecision: { toolCallId, name, decision, reason? }` | What the agent's approver answered for one call — see [Tool approval](#tool-approval). |
| `tool-approval-request` | `toolCall: { id, name, arguments }`          | A call waiting for a decision; the run ends after these.               |
| `finish`          | `usage`, `finishReason`, `limit?`, `interrupt?`     | Terminal — the usage of every call summed; `limit: max-steps` when the step budget ended the run; `interrupt: approval` when it ended with calls waiting for a decision (never both). |

For a run that calls one tool and then answers, the order is:

```
tool-call-delta(id)… · tool-call(id) · step-finish(u1) · message(assistant) · tool-result(id) · message(tool) · text-delta… · step-finish(u2) · message(assistant) · finish(u1+u2)
```

- **Tools run side by side.** The tool calls of one model call run concurrently, up to `maxParallelTools` (default `4`), so their **`tool-result` parts arrive in completion order** — match one to its call by `toolCallId`, never by position. The next model call is still given the results in the order the model asked for them. `maxParallelTools: 1` runs one call at a time, in call order; see [`Ai.Agent` → Tools run side by side](./ai-agent.md#tools-run-side-by-side).

- **`step-finish`** closes each model call when its stream ends and **before** that call's tools run, so a consumer can account for spend call by call — including a run that is cancelled or fails later. A call interrupted by a cancellation before its provider's `finish` reports none; one whose `finish` arrived reports it even when the cancellation lands first.
- **Usage detail.** When the model reports them, a `step-finish` carries that call's `cachedPromptTokens` (the part of `promptTokens` read from a cache) and `reasoningTokens` (the part of `completionTokens` spent reasoning), and `finish` carries their sums. Either is absent when the model does not report it — on `finish`, when no call did — and absent is not zero.
- **`finish`** is the only terminator, and its `usage` is the sum of the `step-finish` usages. It carries `limit: max-steps` when the run ended because `maxSteps` was reached (`onMaxSteps: return` or `conclude`) and no `limit` when the model finished on its own; `finishReason` stays the last model call's own reason.
- **Tool call ids** are assigned by the model and never change: a call's `tool-call-delta` parts (`toolCallId`), its `tool-call` part (`toolCall.id`), a `tool-approval-request` (`toolCall.id`) and a `tool-approval-decision` (`approvalDecision.toolCallId`) about it, the assistant message replayed to the next model call, its `tool-result` (`toolResult.toolCallId`), its tool message and a caller's `approvals` entry all carry the same string. On a resume the ids come from the recorded messages and are never generated again. A whole `tool-call` that arrives with no id gets a generated `call_<uuid>` where it is first seen, unique across calls, runs and processes, so a stored transcript never has two calls under one id.
- The `tool-result` record is an entry of `Ai.Agent`'s `toolResults` plus `output` (see [Tool results](#tool-results)), so a streaming consumer is never a poorer signal than the buffered output.

A consumer that stores the parts types them by reference — `items: !ref Ai.AgentStreamPart` — and `telo check` then reports a misspelled field (`inputs.records[0].usge`) as `CEL_UNKNOWN_FIELD`.

### Tool-call argument deltas

A model that streams a tool call's arguments reports them as `tool-call-delta` parts ahead of the call: each carries the call's `toolCallId`, its `toolName`, and `delta`, the next fragment of the argument text. The fragments of one call, joined in order, are the JSON of its arguments. They let an interface show a call being written — a file's contents arriving, a query taking shape — before the tool runs.

They are **advisory**. The whole `tool-call` always follows, with the parsed `arguments`, and it is the only part a consumer has to handle; a consumer that ignores every `tool-call-delta` loses nothing. Not every model emits them, and the concluding call of `onMaxSteps: conclude` never does. The agent forwards them unchanged; one that names no call id is a broken model contract and rejects the run with `ERR_CONTRACT_VIOLATION`.

### Provider state

A provider that keeps its reasoning server-side reports it as `provider-state` parts. The agent **forwards** each one in order and also **replays** the latest to the next model call, so reasoning survives the tool loop. To continue a conversation's reasoning across runs, keep the last `providerState` a run emitted and pass it back as the next run's `providerState` input: it reaches the first model call unchanged. The value is opaque — nothing in `ai` looks inside it.

## Tool approval

Gating, the `approver` and resuming work exactly as for [`Ai.Agent`](./ai-agent.md#tool-approval) — the code is shared. What is the stream's own is how it reports them.

**A gated call nobody decided** keeps its `tool-call` part and the model call's `step-finish`; the calls beside it run and report as usual; then, once every other call of the response has settled, one `tool-approval-request` per waiting call (carrying the call as `toolCall`), and the terminal `finish` with `finishReason: tool-calls` and `interrupt: approval`:

```
tool-call(c1) · tool-call(c2) · step-finish · message(assistant) · tool-result(c2) · message(tool c2) · tool-approval-request(c1) · finish(interrupt: approval)
```

**An approver's answer** is a `tool-approval-decision` part, one per ask, carrying `approvalDecision: { toolCallId, name, decision, reason? }`:

- `approve` — the decision, then that call's `tool-result` when the tool finishes;
- `reject` — the decision, then a `tool-result` with `denied: true` and its `message`;
- `defer` — the decision, then the `tool-approval-request` and `finish` above.

A decision part is not a message, and a human decision passed in `approvals` emits none. A failed ask rejects the iteration, whatever `onToolError` says.

**Resuming** is another invocation, with `messages` (your stored input followed by every `message` part) and `approvals`. It settles the pending calls first — `tool-result` and `message` parts, no `tool-call` parts, since the calls were reported by the run that asked — and makes its first model call only once nothing is waiting. `approvals` that cannot be placed (`ERR_INVALID_INPUT`) reject the **call**, so a route's `catches:` answers them.

### The `message` part is the record

Every message the run appends to the conversation is emitted as a `message` part, where it is appended: an assistant turn right after its `step-finish`, a tool message right after its `tool-result`, the final answer before `finish`. The input messages and the system prompt are not repeated.

**The caller's input messages followed by every `message` part, in order, is the conversation to pass to the next invocation.** A consumer that persists the conversation stores exactly these parts and nothing else — it does not rebuild messages from deltas, tool calls and results. That holds for a run that ends asking, a run that answers, and a run that fails part-way: a tool that ran before the failure has already emitted its `message`.

A route serving a browser can drop `message` parts from what it forwards — the browser renders from the deltas, tool calls and results, and has no use for the record. Persist them on the server: resuming runs the tool calls recorded in `messages`, with the arguments recorded there, so the conversation must come from your own store and never from the client — see [`Ai.Agent` → Resuming](./ai-agent.md#resuming-a-run-that-ended-asking).

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
data: {"toolCall":{"id":"call_6f1c2a9e-4b7d-4c3a-9e2f-8d5b1a7c0e34","name":"write_file","arguments":{"path":"health.yaml","content":"..."}}}

event: step-finish
data: {"usage":{"promptTokens":180,"completionTokens":40,"totalTokens":220,"unit":"tokens","total":220},"finishReason":"tool-calls"}

event: message
data: {"message":{"role":"assistant","content":"","toolCalls":[{"id":"call_6f1c2a9e-4b7d-4c3a-9e2f-8d5b1a7c0e34","name":"write_file","arguments":{"path":"health.yaml","content":"..."}}]}}

event: tool-result
data: {"toolResult":{"toolCallId":"call_6f1c2a9e-4b7d-4c3a-9e2f-8d5b1a7c0e34","name":"write_file","content":"wrote health.yaml","output":{"path":"health.yaml","bytesWritten":142}}}

event: message
data: {"message":{"role":"tool","content":"wrote health.yaml","toolCallId":"call_6f1c2a9e-4b7d-4c3a-9e2f-8d5b1a7c0e34"}}

event: text-delta
data: {"delta":"Added "}

event: text-delta
data: {"delta":"a health endpoint."}

event: step-finish
data: {"usage":{"promptTokens":220,"completionTokens":8,"totalTokens":228,"unit":"tokens","total":228},"finishReason":"stop"}

event: message
data: {"message":{"role":"assistant","content":"Added a health endpoint."}}

event: finish
data: {"usage":{"promptTokens":400,"completionTokens":48,"totalTokens":448,"unit":"tokens","total":448},"finishReason":"stop"}
```

## Invocation inputs

`prompt` xor `messages`, `system`, `options`, `context` — the caller data the tools read, typed by the mounted providers' `contextType` — `approvals` and `providerState`, as for [`Ai.Agent`](./ai-agent.md#invocation-inputs):

| Field           | Type  | Purpose                                                                             |
| --------------- | ----- | ----------------------------------------------------------------------------------- |
| `approvals`     | array | Decisions on the tool calls `messages` leaves pending: `{ toolCallId, approved, reason? }` each. |
| `providerState` | any   | State a previous run's `provider-state` part carried; handed to the first model call. |

## Cancellation

The first model call is made when the agent is invoked — unless the run resumes pending tool calls, which are settled first, as the stream is read; everything after it runs as the consumer pulls the stream, and each tool call is a real side effect. A consumer that received the stream reads it to its `finish` or cancels it — cancelling it before the first read stops that first model call just as stopping mid-run stops the one in flight. The invocation's context is handed to every model call **and to every tool** (a provider passes it on — `Ai.Tools` into the tool's invocation, `AiMcp.ToolProvider` into its `tools/call`), and cancellation is re-checked after every part, between calls and before each tool. A cancelled turn therefore stops the running model call or every running tool and rejects the stream with `ERR_INVOKE_CANCELLED` — whatever `onToolError` says, since a cancellation is not a tool failure. A durable suspension (`ERR_DURABLE_SUSPENDED`) passes through the same way.

## Terminal & error semantics

These mirror [`Ai.Agent`](./ai-agent.md#when-the-step-budget-runs-out). A failure never becomes a record. *When* it arrives decides who can answer it:

- **Before the stream exists** — the call makes the first model call, and what that call is refused with (a content part the model cannot carry, for one) rejects **this call**, unchanged; so do a malformed call — an `approvals` list that cannot be placed included — a tool-name collision, an `approval.include` name the entry does not expose and an `approver` whose target cannot be resolved, which is resolved for every run whether or not a call is gated. A run resuming pending calls makes no model call from the invocation: the calls are settled, and the first model call made, as the stream is read. In a `mode: stream` route nothing has been sent yet, so the route's `catches:` renders it. Which refusals a model raises from the call is its contract's: [every one it can decide from the request alone](./ai-model.md#when-a-streaming-call-fails).
- **During the run** — anything later **rejects** the iteration, the endpoint's own refusal of the first request included, where a `try:` step that drains the stream sees it. Parts already emitted still reach the consumer, and an encoder frames the rejection for the wire; a route's `catches:` cannot, since the response is under way.

The kind declares `throws: { inherit: true }`: its model's declared codes are part of its own throw union beside the agent's, so a `catches:` list may name them and one with no catch-all must cover them (`UNCOVERED_THROW_CODE`). See [Ai.Text → Errors](./ai-text.md#errors).

- **`onToolError: feedback`** (default) — a failed tool emits a `tool-result` with `error: true`; the tools running beside it finish, and the loop continues so the model can react.
- **`onToolError: throw`** — the first tool error cancels the tools still running and rejects the iteration.
- **`onMaxSteps: return`** — a terminal `finish` with the last call's `finishReason` and `limit: max-steps`.
- **`onMaxSteps: conclude`** — one more model call beyond `maxSteps`, declaring the same tools but forbidden to use one (`toolChoice: none`) and ending with `conclusionPrompt` as a user message. Its text and reasoning parts are emitted like any call's and closed by a `step-finish`; a tool call it returns anyway is neither emitted nor run, and neither are its argument deltas. Then the terminal `finish`, with `limit: max-steps` and that call's usage in the total.
- **`onMaxSteps: throw`** (default) — rejects with `ERR_AGENT_MAX_STEPS`.
- A model stream that ends without a `finish` part, that carries a `tool-call-delta` naming no call id, or that carries two tool calls sharing an id, rejects with `ERR_CONTRACT_VIOLATION`.

## Tool results

A `tool-result` carries two views of one call:

- **`content`** — what was fed back to the model: the tool's `result:` mapping when the tool entry declares one, otherwise the tool's result written as plain JSON (or passed through as a string or content parts).
- **`output`** — what the tool itself returned, before any `result:` mapping, as plain JSON (a timestamp, duration or bytes in its plain encoding). For an MCP tool it is the call's structured content when the server returns one, otherwise its content parts. It is **never sent to the model**; it is there for a consumer — a UI pulling the path a `write_file` tool wrote, a check's exit code — that would otherwise parse the rendering back.

`output` is present on a call that ran and succeeded (a tool that returns nothing reports `null`) and absent when `error` or `denied` is `true`: a failed call has no result, only the error text in `content`, and a denied call never ran — its `content` is what the model was told. `Ai.Agent`'s buffered `toolResults` keep the record the model saw, without `output`.

A tool that returns content parts (e.g. an image) flows through as `MessageContent` on `content`, mirroring `Ai.Agent`. Encoding non-text content parts onto the SSE wire is not yet defined — text/JSON tool results are the supported path today.

## Tracing

With tracing on (a trace sink in the application's `tracing.sinks`, or a debugger attached), a run opens:

| Span | Covers | Attributes |
| --- | --- | --- |
| `invoke_agent <name>` | the whole run, until its `finish` (or failure, or the consumer stops reading) | `gen_ai.operation.name`, `ai.agent.steps` (model calls made), `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` summed over the run |
| `chat <model>` | one model call, until its stream ends | `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| `execute_tool <name>` | one tool call | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `error.type` when it failed |

`chat` and `execute_tool` spans are children of `invoke_agent`, which is a child of the dispatch that started the run. The tool resource's own dispatch span nests under its `execute_tool` span (see [`Ai.Tools`](./ai-tool-provider.md#aitools)). `<model>` is the model resource's published `model` (the provider's model id), else the resource's name. A span that ends because the consumer stopped reading is `cancelled`. No span carries message content, tool arguments or tool results.

With `maxToolResultBytes` set, `content` is bounded — at most that many UTF-8 bytes of text, cut at a character boundary, with media parts untouched — and a cut result ends with the marker

```
[truncated: <omitted> of <total> bytes cut; a tool result passes at most <limit> bytes to the model]
```

on its own line (a final text part for a part result). Error results are bounded the same way. `output` is never bounded. The full rules are [`Ai.Agent` → Bounded tool results](./ai-agent.md#bounded-tool-results).
