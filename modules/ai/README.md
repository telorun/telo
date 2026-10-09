# AI

Model access for Telo — defines the `Ai.Model` and `Ai.ImageModel` abstracts every provider implements and ships ready-to-use buffered, streaming and image consumers.

## Why use this

- **Provider-agnostic** — swap models by changing one resource reference; no controller code touches LLM SDKs directly.
- **Buffered and streaming** — `Ai.Text` returns a complete response; `Ai.TextStream` exposes an async iterable of `StreamPart` records.
- **Text and images** — `Ai.Image` turns a prompt into picture bytes, or reworks pictures you supply, through the same provider you already configured.
- **Multimodal turns** — a message's content is text or parts: images, audio, video and documents by bytes or by URI, in one vocabulary every model shares.
- **Composable encoding** — pipe a stream through any `Codec.Encoder` (NDJSON, SSE, plain text, raw bytes) without bespoke serialization.
- **Open for extension** — both model abstracts are `Telo.Abstract`s; any module declaring `extends` is a drop-in provider.
- **Traced** — with tracing on, an agent run is an `invoke_agent` span with a `chat` span per model call and an `execute_tool` span per tool call, carrying token usage and finish reasons but never message content; each tool's own dispatch nests beneath its call.
- **Typed contract** — provider input and output are validated by JSON Schema. `Ai.ImageModel` declares its call shape in the manifest, so the kernel enforces it at dispatch and a provider in any language has a contract to implement.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Ai.Model` | Declared contract for a model called for a complete answer. One bound entry point, `invoke`. |
| `Ai.ModelStream` | The same, delivered as parts as they are generated. A separate abstract — see below. |
| `Ai.Buffered` | Presents an `Ai.ModelStream` as an `Ai.Model`, folding its parts into one answer. |
| `Ai.Text` | Buffered single-turn call over any `Ai.Model`. |
| `Ai.TextStream` | Streaming counterpart over any `Ai.ModelStream`; returns `{ output: Stream<StreamPart> }`. |
| `Ai.Agent` | Tool-use loop over any `Ai.Model` — calls tools, replays results, loops to a final answer; typed caller context for its tools, tool calls that wait for approval, the messages to persist, and a step budget that can end in a concluding answer. |
| `Ai.AgentStream` | The same loop, streaming its parts as it goes — each model call's usage, every tool call under a stable id, each tool's result beside what the model was told, every appended message as a record, approval decisions and requests, and provider state. |
| `Ai.ToolProvider` | Abstract contract every agent tool source implements (`listTools` + `callTool`, optionally `toolRequiresApproval`). |
| `Ai.Tools` | Built-in `Ai.ToolProvider`: a static list of tools, each wrapping any `Telo.Invocable`, with a declared type for the caller context their mappings read and a per-tool approval gate. |
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
- [`Ai.AgentStream`](docs/ai-agent-stream.md) — the streaming loop: its parts, tool results and spans.
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
  | { type: "tool-call-delta"; toolCallId: string; toolName: string; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "provider-state"; providerState: unknown };
```

A streaming model names its own tool calls: every `tool-call-delta` carries the id of the `tool-call` that completes it, none is emitted before that id is known, and an id the endpoint never gives is minted unique (`call_<uuid>`). See [Tool calls in a stream](./docs/ai-model.md#tool-calls-in-a-stream-and-who-names-them).

`Ai.Text` and `Ai.Agent` hold an `Ai.Model`; `Ai.TextStream` and `Ai.AgentStream` hold an `Ai.ModelStream`, whose `invoke()` returns `{ output: Stream<StreamPart> }`. `Ai.AgentStream`'s own output is a `Stream` of `Ai.AgentStreamPart` — the model's parts plus `step-finish` per model call, `tool-result` per tool, `message` per message appended to the conversation, and the approval parts — exported as a `Telo.JsonSchema` so a consumer types what it reads (`items: !ref Ai.AgentStreamPart`); see [`Ai.AgentStream`](./docs/ai-agent-stream.md). Both entry points are bound and contract-checked by the kernel, so a consumer validates nothing by hand.

`Ai.Buffered` adapts the second to the first: give it an `Ai.ModelStream` and it drives the stream, collects the parts and folds them into one completed answer. That is what makes a provider which only streams usable by `Ai.Text` and `Ai.Agent`. Use a provider's own buffered kind where it has one — collecting a stream to hand back a single answer pays a stream's latency for a buffer's result.

```yaml
kind: Ai.Buffered
metadata: { name: folded }
model: !ref someStreamingProvider
```

A stream **fails by rejecting**: `finish` is the only terminal part, and a mid-stream failure rejects the iteration with a structured error. An error part would have to be remembered by every drainer, and one that forgets truncates silently; a thrown error also reaches `catches:`, a throws union and a `try:` step. Parts already yielded still reach the consumer, and both shipped encoders frame the rejection — carrying its `code` — so a streaming client still sees one terminal frame.

## Content parts

A message's `content` is a string, or a list of `Ai.ContentPart`s when it carries anything but text. A media part — `image`, `audio`, `video`, `file` — holds its `mediaType` and exactly one of `data` (the bytes, or base64 in a manifest) or `uri` (an absolute URI, never `data:`), plus an optional file `name`:

```yaml
messages:
  - role: user
    content:
      - { type: text, text: "Summarize the attached report." }
      - { type: file, mediaType: application/pdf, name: report.pdf, data: !cel "steps.read.result.data" }
      - { type: image, mediaType: image/png, uri: "https://example.com/chart.png" }
```

**Shape and capability are separate.** What a part must carry is declared once, in `Ai.ContentPart`, and enforced by the contract of every kind that takes a message: a malformed literal is `CONTRACT_INPUTS_MISMATCH` under `telo check`, at the key at fault, and a malformed computed value is `ERR_INPUT_INVALID` at dispatch. Whether a given model can *carry* a well-formed part is the provider's answer, raised under a code the provider declares before it sends anything. A `uri` is passed to the model as written; nothing here fetches it. See [Modality lives in the parts](docs/ai-model.md#modality-lives-in-the-parts).

## Usage

Every completion returns `usage`: `promptTokens`, `completionTokens`, `totalTokens`, and the provider-neutral `unit` / `total` that let one consumer sum spend across modalities. When the model reports them it also carries `cachedPromptTokens` — the part of `promptTokens` read from a cache — and `reasoningTokens` — the part of `completionTokens` spent reasoning. Each is present only when reported: absent means the model did not say, which is not zero. An agent sums both across its model calls; `Ai.AgentStream` also reports them per call on each `step-finish`.

## Catching a model's errors

`Ai.Text`, `Ai.TextStream`, `Ai.Agent`, `Ai.AgentStream` and `Ai.Buffered` each declare `throws: { inherit: true }`: whatever the model they hold throws escapes them unchanged, so the model's declared codes are part of the operation's own throw union. Two things follow:

- A `catch:` step or a route's `catches:` over one of these may name a code the **model** declares and read its declared `error.data`.
- `telo check` holds a `catches:` list to the whole union. A list that names some codes and has no catch-all is `UNCOVERED_THROW_CODE`, listing the operation's remaining codes *and its model's*.

For a streaming operation, a request the model refuses outright fails the call — before any byte of the response — so a `mode: stream` route's `catches:` still renders it. See [`Ai.Text` → Errors](docs/ai-text.md#errors) for a worked route.

## Tool use

Tool use / function calling is provided by [`Ai.Agent`](docs/ai-agent.md): it advertises tools to the model, executes the ones the model requests, and loops. Tools come from any [`Ai.ToolProvider`](docs/ai-tool-provider.md) — a static [`Ai.Tools`](docs/ai-tool-provider.md#aitools) list, or runtime discovery from an MCP server via [`AiMcp.ToolProvider`](../ai-mcp/README.md). The model contract carries tools additively (`tools` in, `toolCalls` out, the `tool` message role); `Ai.Text`/`Ai.TextStream` never pass tools and are unaffected.

**Caller context.** Either agent takes a `context` input — data its caller knows and the model must not choose, such as the id of the turn being served. A provider's tools read it in their `inputs:` mapping (`turnId: !cel "context.turnId"`), and the provider declares its shape as `contextType`; the agent's `context` must then satisfy every mounted provider's declaration, checked by `telo check` at the call and at invoke before any model call. See [Caller context](docs/ai-agent.md#caller-context). The module declares `requires: telo: ">=0.107.0"`, the first runtime that derives this contract and that accepts a model call whose `messages` is computed; an older one reports `MODULE_REQUIRES_NEWER_RUNTIME`.

**The step budget.** `maxSteps` bounds the model calls of a run, and `onMaxSteps` says what reaching it means: `throw` (`ERR_AGENT_MAX_STEPS`), `return` the last turn, or `conclude` — one more call that declares the tools but may not use one (`toolChoice: none`) and ends with `conclusionPrompt`, so a run that ran out of steps still ends with an answer. A result the budget ended carries `limit: max-steps`. `conclusionPrompt` without `conclude` is refused by `telo check` (`AI_CONCLUSION_PROMPT_UNUSED`) and at creation (`ERR_AI_CONCLUSION_PROMPT_UNUSED`). See [When the step budget runs out](docs/ai-agent.md#when-the-step-budget-runs-out).

**Tool choice.** A model call may carry `toolChoice: none` beside its `tools`: answer without requesting one, with the tools still declared so the conversation's earlier calls stay valid. See [`Ai.Model`](docs/ai-model.md#toolchoice--a-call-that-may-not-use-a-tool).

**Tool approval.** A tool call can need a decision before it runs. Two sources gate a call and either one is enough: the agent's entry, by tool name (`toolProviders[].approval: { include?, exclude? }` — prefer `exclude` for a provider whose tool list can change, so a tool added later is gated), and the tool's own provider, per call (`approval:` on an `Ai.Tools` entry, `true` or a CEL condition over the call's `arguments` and the caller's `context`). A gated call goes to the agent's `approver` — any invocable, given `toolCall` and `tool` through an `inputs:` mapping and answering `approve`, `reject` or `defer` through a `result:` mapping — or, with none or on `defer`, ends the run with `interrupt: approval` and the waiting calls. The run continues on a later invocation from the recorded messages plus `approvals: [{ toolCallId, approved, reason? }]`; a human decision wins over the approver, a refused call is reported to the model as denied (`denied: true` on its result), and nothing is remembered between runs. A gate answering with anything but a boolean fails that call rather than letting it through, an approver's answer is held to `{ decision, reason? }` exactly, and its target is resolved when a run starts. A name in an entry's `approval.include` that the provider does not expose is `ERR_AGENT_APPROVAL_UNKNOWN_TOOL` when the tools are assembled, and over an `Ai.Tools` provider `telo check` refuses it first (`REFERRER_RULE_VIOLATED`, rule `AGENT_APPROVAL_UNKNOWN_TOOL` / `AGENT_STREAM_APPROVAL_UNKNOWN_TOOL`). A failed ask fails the run whatever `onToolError` says, and the approver's token usage is not counted in the agent's. See [Tool approval](docs/ai-agent.md#tool-approval).

**What a buffered run returns.** Beside `text`, `usage` and `finishReason`, `Ai.Agent` returns `steps` — one `{ text, toolCalls }` entry per model call the run made — and `toolResults` — one `{ toolCallId, name, content, error?, denied? }` entry per tool call the run settled, calls a previous run left pending included, in the order they were recorded. Both are closed shapes, so CEL over them is type-checked. See [Output](docs/ai-agent.md#output).

**The record.** Both agents report every message they append to the conversation — each assistant turn, each tool result, the final answer: `Ai.Agent` as its `messages` output, `Ai.AgentStream` as `message` parts in the same order. The input messages followed by that record is the conversation to persist and to pass to the next run. Resuming runs the tool calls recorded there, arguments included, so load the conversation from your own store and never from the client. See [The record](docs/ai-agent.md#the-record).

**Parallel tools.** The tool calls of one model response run side by side, up to `maxParallelTools` on either agent (default `4`). The streaming agent reports each result as it completes; the model is always given them in the order it asked. An agent whose tools depend on each other's side effects within one response sets `maxParallelTools: 1`. Under `onToolError: throw` the first failure cancels the calls still running. See [Tools run side by side](docs/ai-agent.md#tools-run-side-by-side).

**Streamed tool arguments.** A streaming model reports a tool call's arguments as they are written, as `tool-call-delta` parts under the call's id, ahead of the whole `tool-call`; `Ai.AgentStream` forwards them. They are advisory. See [Tool-call argument deltas](docs/ai-agent-stream.md#tool-call-argument-deltas).

`maxToolResultBytes` on either agent bounds the UTF-8 bytes of text every tool result feeds the model — static and MCP tools alike, error results included — keeping the longest whole-character prefix and ending a cut result with `[truncated: <omitted> of <total> bytes cut; a tool result passes at most <limit> bytes to the model]`; media parts are never counted or cut, and a tool-result's `output` stays whole. Unset, results are unbounded. See [Bounded tool results](docs/ai-agent.md#bounded-tool-results).

## What is logged

Every completion kind — `Ai.Text`, `Ai.TextStream`, `Ai.Agent` and `Ai.AgentStream` — logs **token usage and finish reason at `info`**, carrying `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and `gen_ai.response.finish_reasons`. Usage is the metered quantity: what a run cost, and why a bill moved. Tracing carries the call's shape but is off unless asked for, and the returned `usage` object is only as visible as whatever the caller does with it.

Both agents report the **aggregate across every turn** plus `ai.agent.steps` — the model calls the run made, the answering call included — since a per-turn figure would understate an agent that looped eight times. An agent that hits `maxSteps` with `onMaxSteps: return` logs at `warn`: the last turn is handed back as it stands — a value, or a terminal `finish` frame — marked `limit: max-steps`. One that concludes logs its totals at `info`, with `ai.agent.max_steps`.

A streamed run reports when its terminal part is reached, so a consumer that abandons the stream produces no record — correctly, since no usage was ever reported. One `info` per completion means a 1,000-completion batch is 1,000 records; that is the intended trade for usage being visible by default, and `logging.sampling` bounds it if you need it to.

The record is emitted by the **operation**, not the provider — the same grain the module already normalizes usage on — so a provider published by someone else reports identically without doing anything.

**Prompts, messages and completions are never logged.** They are the user's content, frequently the most sensitive thing in the process, and no threshold is the right place to decide to spill them.

## Out of Scope

- **Structured outputs / JSON mode** — `responseFormat` carries the request to a provider that enforces one; nothing here validates the answer against it.
- **Multi-provider routing / failover** — hold two models and choose in the manifest.
- **Prompt templating** — CEL at the call site is the templating.
