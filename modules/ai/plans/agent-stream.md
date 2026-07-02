# Ai.AgentStream — a streaming tool-use agent

## Problem

`Ai.Agent` runs a tool-use loop but returns a single buffered result — the caller
sees nothing until every model turn and tool call has finished. The AI
manifest-authoring agent (`apps/authoring-agent`) needs the opposite: the
assistant's text should type out token-by-token and each tool call (every file
write, every `telo check`) should surface the moment it happens, so the editor can
react live. Today there is no way to observe an agent mid-loop. `Ai.TextStream`
streams text but has no tools; `Ai.Agent` has tools but no streaming. We need a
consumer kind that is both.

## Solution

Add `Ai.AgentStream` to `modules/ai` — a streaming Invocable that mirrors
`Ai.Text` → `Ai.TextStream`, standing to `Ai.Agent` as `Ai.TextStream` stands to
`Ai.Text`. It drives the same tool-use loop but emits a `Stream` of tagged events
on `result.output` (`x-telo-stream: true`) instead of a buffered object. A
consumer pipes that stream through an `Sse.Encoder` in an `Http.Api`
`mode: stream` route to get token-level SSE — the transport already proven by
`modules/http-server/tests/text-stream-via-http.yaml`.

Two distinct event unions, both defined as named types in
`modules/ai/nodejs/src/types.ts` — the review's central point is that the agent's
output must be a real contract, not `StreamPart` plus prose:

- **`StreamPart`** (model-facing, what a provider's `stream()` yields) gains one
  additive variant, `tool-call`, carrying a fully-assembled `ToolCall`
  (`id`, `name`, `arguments`). Backward-safe: `Ai.TextStream` never passes `tools`,
  so it never emits or observes it. The buffered `invoke()` path is untouched.
- **`AgentStreamPart`** (the deliverable — what `Ai.AgentStream` yields) is defined
  as `StreamPart` **plus** a `tool-result` variant, so the shared members
  (`text-delta`, `tool-call`, `finish`, `error`) reuse one definition and the agent
  adds exactly one member of its own. The `tool-result` shape is pinned to match the
  buffered agent's `StepTrace.toolResults` record exactly —
  `{ toolCallId, name, content, error? }` — so the streaming consumer is never a
  strictly poorer event than the buffered one. `content` is typed `MessageContent`
  (string **or** content parts), mirroring the buffered agent. This concrete union
  is also the element type the `outputType`'s `x-telo-stream` binds to, ready for
  the future `{ items: <AgentStreamPart schema> }` form.

Three implementation pieces, bottom-up:

1. **OpenAI provider** (`modules/ai-openai/nodejs/src/openai-model-controller.ts`).
   Its `stream()` currently reads only `delta.content`. OpenAI streams tool calls
   as incremental `delta.tool_calls[]` fragments keyed by index, with `arguments`
   arriving as concatenated JSON-string chunks. The provider accumulates fragments
   per index and, at the finish boundary, emits one `tool-call` `StreamPart` per
   assembled call (reusing the existing argument-parsing helper). Text deltas keep
   flowing token-by-token. OpenAI is the only production provider; the sole other
   `stream()` implementer is the hermetic echo model.

2. **Shared tool-loop unit — assembly *and* dispatch, output-neutral.** Both halves
   of `Ai.Agent`'s tool logic are mirrored by `Ai.AgentStream` (it copies the same
   `toolProviders` schema), so both must be extracted or the streaming controller
   drifts:
   - **Assembly** (`assembleTools`): provider merge, `prefix`/`include`/`exclude`
     application, `listTools()` fan-out, and duplicate-name collision detection —
     lifted verbatim into the shared unit and called by both agents.
   - **Dispatch** (`dispatchCall`): today it executes a tool **and** mutates a
     buffered-only `StepTrace`. The shared version does only lookup, `callTool`, and
     error classification and **returns a neutral record**
     `{ toolCallId, name, content, error? }` — no trace, no events. Each agent
     renders it: buffered → pushes onto `StepTrace`; streaming → emits a
     `tool-result` event.

   One assembly + one dispatch implementation, two renderers — the no-drift
   guarantee is in the seam, not the word "helper".

3. **`Ai.AgentStream` kind** (`modules/ai/telo.yaml` + a new controller). An
   Invocable whose schema mirrors `Ai.Agent` (`model`, `system`, `options`,
   `maxSteps`, `onMaxSteps`, `onToolError`, `toolProviders`) and whose `outputType`
   is the streaming shape (`output`, `x-telo-stream: true`, element type
   `AgentStreamPart`). The controller runs the multi-turn loop against
   `model.stream()`, one turn per call, forwarding `text-delta` and `tool-call`
   parts through. Two loop-control details the review flagged, specified here:

   - **Per-turn finish is consumed, not forwarded.** Every `model.stream()` turn
     yields its own `finish` part (echo does; OpenAI will). The controller reads its
     `usage` (accumulating across turns) and `finishReason` but does **not** forward
     it. On `finishReason: tool-calls` it dispatches each collected call via the
     shared unit, emits a `tool-result` event, appends the tool messages, and loops.
     On `finishReason: stop` (or maxSteps/error handling) it emits exactly **one**
     synthesized terminal `finish` with the accumulated `usage`. The downstream SSE
     consumer therefore sees a single terminal frame, never one per turn.
   - **Cancellation is re-checked inside the generator.** Unlike `Ai.TextStream`
     (one `model.stream()`, signal captured once), this loop runs lazily as the SSE
     consumer pulls, and each turn executes real side effects (file writes, shell
     commands). The controller threads the invoke's cancellation signal into the
     generator: it calls `throwIfCancelled()` between turns and before each tool
     dispatch, and passes the signal to every `model.stream()` call. An abandoned
     connection stops the loop before the next model turn or tool execution, so a
     disconnected client cannot keep mutating the workspace.

   Added to `exports.kinds`.

Because the SSE encoder maps the `type` field to the SSE `event:` and the rest to
`data:`, the editor consumes `tool-call` events as its file-mutation stream
directly — no separate fs event sink (bash-written files fall to the app's
tree-hash backstop).

Hermetic coverage in `modules/ai/tests`: the echo fixture's `stream()` is extended
so that when `emitToolCall` and `tools` are set and no tool result exists yet, the
tool-calling turn emits a `tool-call` part **and** reports its `finish` as
`finishReason: "tool-calls"` (mirroring its `invoke()`, which already returns
`tool-calls`). This is what lets the loop drive a second turn — a `finish` left at
`"stop"` would terminate after one turn and the multi-turn behaviour could not be
exercised. Once a tool result is present the next turn streams text and finishes
`stop` as usual. A new test asserts the full
`tool-call → tool-result → text-delta → finish` order, exactly one terminal
`finish` with accumulated `usage`, and the pinned `tool-result` fields, without a
live provider.

Docs and versioning (mandatory per repo convention): add
`modules/ai/docs/ai-agent-stream.md` and wire it into `pages/docusaurus.config.ts`
+ `pages/sidebars.ts`; update `modules/ai-openai/docs/ai-openai-model.md` to note
streaming tool calls. A changeset for `@telorun/ai` (new kind — minor) and one for
`@telorun/ai-openai` (streaming tool-call support — minor); both are Node
controller changes, so their changie module fragments are auto-generated by
`scripts/version-packages.mjs` and no hand-written fragment is needed. Additive
throughout — no major bump.

The app side — `apps/authoring-agent` composing `Ai.AgentStream` over SSE with the
`fs`/`shell` tools — stays in its own plan
(`apps/authoring-agent/plans/ai-authoring-agent-first-step.md`), whose buffered-agent
assumption is corrected to reference `Ai.AgentStream`.

## Decisions

- **New `Ai.AgentStream` kind, not a flag on `Ai.Agent`.** Output shape is
  statically typed per consumer kind — buffered object vs. streaming `output` —
  the same split already made for `Ai.Text`/`Ai.TextStream`. A mode flag would make
  one kind's `outputType` ambiguous. This is the "pure additive consumer PR" the
  model plan anticipated (`model-and-completion.md` §12).
- **Two named unions: `StreamPart` (model) and `AgentStreamPart` (agent), the
  latter reusing the former plus `tool-result`.** The agent's stream is the module's
  real deliverable, so it gets a schema, not narrative. Defining it as a superset
  keeps the shared members single-sourced. `tool-call` still lands on the shared
  `StreamPart` because the loop must read one provider-agnostic contract.
- **`tool-result` pinned to the buffered agent's record
  (`{ toolCallId, name, content, error? }`).** Dropping `toolCallId` or the `error`
  flag would make the streaming event strictly poorer than the buffered trace and
  break the mirror claim. `content` stays `MessageContent`.
- **Multimodal (content-parts) tool results: carried in the type, wire-framed
  later.** The event's `content` is typed `MessageContent` so image tool results
  are not structurally excluded and the mirror to `Ai.Agent` holds at the type
  level. SSE framing of non-text content parts (a base64 image in a `data:` frame)
  is explicitly **out of scope for this slice** — the authoring agent's `fs`/`shell`
  tools return text/JSON, and the editor's file-mutation consumer assumes text. A
  follow-up defines the wire encoding when an image-returning tool actually streams.
- **Shared unit covers assembly *and* dispatch, not dispatch alone.** Provider
  merge, prefix/include/exclude, collision detection, and `listTools()` fan-out are
  as mirrored as dispatch is; extracting only dispatch would still let the streaming
  controller reimplement assembly and drift. Both are lifted; dispatch additionally
  returns an output-neutral record (buffered → `StepTrace`, streaming → event) so it
  isn't coupled to a buffered trace.
- **The loop consumes per-turn `finish` and synthesizes one terminal `finish`.**
  Each model turn finishes; forwarding those would emit multiple `finish` frames and
  a premature terminal. The controller accumulates `usage` across turns and emits a
  single terminal `finish`. Continuation is driven by `finishReason: tool-calls`,
  which the tool-calling turn (including the echo fixture) must report.
- **Cancellation is active inside the generator, not capture-once.** Because the
  loop executes side-effecting tools lazily as the consumer pulls, the signal is
  re-checked between turns and before each dispatch and forwarded to every
  `model.stream()` — a dropped connection stops workspace mutation. This is a
  behavioral requirement given fs/shell tools, not an optimization.
- **Token-level text streaming (Option B), not step-level.** Step-level emits text
  one chunk per turn — indistinguishable from buffered for a single-reply turn,
  which reads as "not streaming". Real token streaming is the point; its cost is
  provider-side tool-call accumulation, contained to `ai-openai`.
- **Terminal/error semantics mirror `Ai.Agent`, re-expressed as events.** Tool
  error with `onToolError: feedback` (default) → emit `tool-result` with
  `error: true` and continue; `throw` → terminal `error` part, end. maxSteps hit
  with `onMaxSteps: return` → terminal `finish`; `throw` (default) → terminal
  `error` part. `usage` accumulates across turns, reported in the terminal `finish`.
  No new failure vocabulary.
- **Plan scoped to the `modules/ai` primitive.** The reusable stdlib primitive and
  the `authoring-agent` app affect different packages; each keeps its plan in the
  package it most affects. The app plan is updated, not merged in here.

## Complete example after the change

A route that streams a tool-using agent as SSE — the assistant's reply arrives
token-by-token and each file write appears as a `tool-call` event as it happens:

```yaml
kind: Ai.AgentStream
metadata: { name: Author }
model: !ref Gpt4o
system: |
  You author Telo YAML manifests in the workspace. Use write_file / edit_file to
  make changes and `run` to validate with `telo check`.
maxSteps: 12
toolProviders:
  - provider: !ref WorkspaceTools
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

Wire output for a turn that writes one file then replies (note the pinned
`tool-result` fields — `toolCallId` and `error` carry through):

```
event: tool-call
data: {"toolCall":{"id":"call_0","name":"write_file","arguments":{"path":"health.yaml","content":"..."}}}

event: tool-result
data: {"toolCallId":"call_0","name":"write_file","content":"{\"bytesWritten\":142}","error":false}

event: text-delta
data: {"delta":"Added "}

event: text-delta
data: {"delta":"a health endpoint."}

event: finish
data: {"usage":{"promptTokens":220,"completionTokens":48,"totalTokens":268},"finishReason":"stop"}
```
