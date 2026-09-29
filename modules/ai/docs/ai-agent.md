---
description: "Ai.Agent: a tool-use loop over any Ai.Model. Tool providers, maxSteps/onMaxSteps/onToolError, bounded tool results, invocation inputs and the steps trace."
sidebar_label: Ai.Agent
---

# `Ai.Agent`

> Examples assume aliases `Ai` (this module), `OpenAI` (`openai`), `Http` (`http-client`), and `Js` (`javascript`). Substitute if you import under different names.

`Ai.Agent` is a `Telo.Invocable` that runs a **tool-use loop** over any `Ai.Model`: it calls the model with a set of tools, executes whatever tools the model requests, replays the results, and repeats until the model produces a final answer (or a step cap is hit). The loop lives in the controller — not the provider — so it is provider-agnostic and every turn is observable in the returned `steps` trace.

Tools come from one field, `toolProviders`: a list of references to any [`Ai.ToolProvider`](./ai-tool-provider.md). Both a static list ([`Ai.Tools`](./ai-tool-provider.md#aitools)) and runtime MCP discovery (`AiMcp.ToolProvider`, from `@telorun/ai-mcp`) are providers — the agent treats them uniformly.

```yaml
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
kind: Js.Script
metadata: { name: Multiplier }
code: |
  function main({ a, b }) { return { product: a * b }; }
---
kind: Ai.Tools
metadata: { name: LocalTools }
tools:
  - tool: !ref Multiplier
    name: multiply
    description: Multiply two numbers.
    parameters:
      type: object
      additionalProperties: false
      required: [a, b]
      properties: { a: { type: number }, b: { type: number } }
---
kind: Ai.Agent
metadata: { name: Assistant }
model: !ref Gpt4o
system: "Use tools when helpful."
maxSteps: 8
toolProviders:
  - provider: !ref LocalTools
```

## Manifest fields

| Field           | Type            | Required | Purpose                                                                                  |
| --------------- | --------------- | -------- | ---------------------------------------------------------------------------------------- |
| `model`         | ref (`Ai.Model`)| yes      | The LLM that drives the loop.                                                            |
| `system`        | string          | no       | Default system prompt. Runtime `inputs.system` wins.                                     |
| `options`       | object          | no       | Option overrides passed to the model each turn (merged under `inputs.options`).          |
| `maxSteps`      | integer         | no       | Max model turns. Default `8`.                                                            |
| `onMaxSteps`    | `throw\|return` | no       | At the cap without finishing: `throw` raises `ERR_AGENT_MAX_STEPS`; `return` hands back the last turn's text (`finishReason: tool-calls`). Default `throw`. |
| `onToolError`   | `feedback\|throw`| no      | When a tool throws or the model names an unknown tool: `feedback` records it in `steps` and returns it to the model so it can recover; `throw` aborts. Default `feedback`. A cancelled invocation and a durable suspension are not tool errors: they propagate either way. |
| `maxToolResultBytes` | integer ≥ 1 | no | Bounds the text each tool result feeds the model — see [Bounded tool results](#bounded-tool-results). Unset: unbounded. |
| `toolProviders` | array           | no       | Tool sources — see below.                                                                |

### `toolProviders[]`

| Field      | Type                  | Required | Purpose                                                       |
| ---------- | --------------------- | -------- | ------------------------------------------------------------- |
| `provider` | ref (`Ai.ToolProvider`)| yes     | A static list, MCP server, or any provider.                   |
| `prefix`   | string                | no       | Namespaces this provider's tool names (avoids collisions).    |
| `include`  | string[]              | no       | Allowlist of bare tool names to expose.                       |
| `exclude`  | string[]              | no       | Denylist of bare tool names.                                  |

Tools are listed lazily on first invoke and cached. A name clash across providers that a `prefix` doesn't resolve is `ERR_AGENT_TOOL_COLLISION`.

## Invocation inputs

| Field      | Type   | Required                          | Purpose                                                      |
| ---------- | ------ | --------------------------------- | ------------------------------------------------------------ |
| `prompt`   | string | exactly one of `prompt`/`messages`| Shorthand for `messages: [{ role: user, content: prompt }]`. |
| `messages` | array  | exactly one of `prompt`/`messages`| Full turns.                                                  |
| `system`   | string | no                                | Runtime system override (wins over manifest `system`).       |
| `options`  | object | no                                | Per-call option overrides.                                   |

## Output

`{ text, usage, finishReason, steps }`:

- `text` — the model's final answer.
- `usage` — token usage summed across every model call in the loop.
- `finishReason` — from the final turn.
- `steps` — one entry per model call, the final answering call included (its `toolCalls` and `toolResults` are empty), so `steps` has as many entries as the run made model calls: `{ text, toolCalls, toolResults }`, where each result carries `{ toolCallId, name, content, error? }`. A call's id is fixed when the model requests it — a model that supplies none gets a generated `call_<uuid>`, unique across runs — and the result's `toolCallId` and the replayed assistant message carry the same one. `content` is the tool's reply — a string, or **content parts** (`ContentPart[]`) when a tool answered with an image; the agent carries parts through to the model untouched rather than JSON-stringifying them. Failures appear here too (not swallowed).

## Bounded tool results

`maxToolResultBytes` caps the UTF-8 bytes of text each tool result passes to the model, so one oversized reply (a large file, a long log) cannot fill the agent's context window. It applies to every tool whatever provider serves it — an `Ai.Tools` entry and an MCP tool alike — and to error results (`Error: …`) as well as successful ones. Only text is measured:

- a **string** result longer than the limit keeps its longest prefix of whole characters within the limit;
- a **content-part** result counts its text parts in order: the part the limit falls in is cut at a character boundary and every later text part is dropped; media parts (images, audio, files) are neither counted nor cut and keep their positions;
- a result within the limit is passed through unchanged.

A cut result is followed by the marker, exactly:

```
[truncated: <omitted> of <total> bytes cut; a tool result passes at most <limit> bytes to the model]
```

(decimal byte counts over the text) — on its own line after the kept text for a string result, or as a final text part for a part result. The marker says what was cut, never how to get the rest: telling the model how to page through a particular tool belongs in the agent's own system prompt. The bound is per agent rather than per tool, because what it protects is the agent's context. The `steps` trace records the bounded `content` — what the model saw — and [`Ai.AgentStream`](./ai-agent-stream.md#tool-results)'s `output` keeps what the tool returned whole.

```yaml
kind: Ai.Agent
metadata: { name: Assistant }
model: !ref Gpt4oMini
maxToolResultBytes: 32768
toolProviders:
  - provider: !ref WorkspaceTools
```

## Tracing

With tracing on, a run opens an `invoke_agent <name>` span over the whole run, a `chat <model>` span per model call and an `execute_tool <name>` span per tool call, with the OpenTelemetry GenAI attributes — token usage, finish reasons, tool name and call id, `error.type` on a failed tool — and never message content. The spans and their attributes are the streaming agent's: see [`Ai.AgentStream` → Tracing](./ai-agent-stream.md#tracing).

## Cancellation

The invocation's context reaches every model call and every tool: the agent hands it (through the call's span context) to the tool provider's `callTool`, which passes it on to whatever runs the tool. Cancelling the invocation — a step's `timeout:`, a cancelled run — stops a running tool and ends the agent with `ERR_INVOKE_CANCELLED`, under either `onToolError`.

## See also

- [`Ai.ToolProvider` / `Ai.Tools`](./ai-tool-provider.md) — the tool contract and the static-list provider.
- [`Ai.Text`](./ai-text.md) — single-turn buffered call (no tools).
