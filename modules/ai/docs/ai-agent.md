---
description: "Ai.Agent: a tool-use loop over any Ai.Model. Tool providers, typed caller context, the step budget (maxSteps/onMaxSteps/conclusionPrompt), onToolError, bounded tool results, invocation inputs and the steps trace."
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
| `maxSteps`      | integer         | no       | Max model turns. Default `8`. May be computed (`!cel "variables.maxSteps"`), resolved once at startup. |
| `onMaxSteps`    | `throw\|return\|conclude` | no | At the cap without finishing — see [When the step budget runs out](#when-the-step-budget-runs-out). Default `throw`. |
| `conclusionPrompt` | string (markdown) | no  | The final user message of the concluding call. Only with `onMaxSteps: conclude`; has a default wrap-up text. |
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
| `context`  | object | no                                | Data from the caller for the tools to read — see [Caller context](#caller-context). Default `{}`. |

## Caller context

`context` carries data the caller knows and the model must not choose: the id of the turn being served, the signed-in user, a tenant. It is never sent to the model. Each mounted provider's tools read it in their `inputs:` mapping as `context` (see [`Ai.Tools`](./ai-tool-provider.md#caller-context)), and a provider says what it needs by declaring a `contextType`.

The agent's `context` input is typed by those declarations: it must satisfy the `contextType` of **every** provider under `toolProviders` that declares one, and a provider declaring none (an MCP provider, a static list reading no caller data) asks for nothing. An omitted `context` is `{}`, so an agent whose provider requires `turnId` must be called with it:

```yaml
- name: reply
  invoke: !ref Assistant
  inputs:
    prompt: !cel "inputs.prompt"
    context:
      turnId: !cel "inputs.turnId"
```

A call that does not satisfy them is `CONTRACT_INPUTS_MISMATCH` at its `inputs:` under `telo check`, and `ERR_INPUT_INVALID` when invoked — before any model call is made. With several providers, declare each `contextType` open (no `additionalProperties: false`), since one value has to satisfy all of them. A provider the agent reaches only through a library's `resources:` input is not known to `telo check`; it is still enforced when the agent is invoked.

## Output

`{ text, usage, finishReason, limit?, steps }`:

- `text` — the model's final answer.
- `usage` — token usage summed across every model call in the loop.
- `finishReason` — from the final turn.
- `limit` — `max-steps` when the step budget ended the run (`onMaxSteps: return` or `conclude`); absent when the model finished on its own.
- `steps` — one entry per model call, the final answering call included (its `toolCalls` and `toolResults` are empty), so `steps` has as many entries as the run made model calls: `{ text, toolCalls, toolResults }`, where each result carries `{ toolCallId, name, content, error? }`. A call's id is fixed when the model requests it — a model that supplies none gets a generated `call_<uuid>`, unique across runs — and the result's `toolCallId` and the replayed assistant message carry the same one. `content` is the tool's reply — a string, or **content parts** (`ContentPart[]`) when a tool answered with an image; the agent carries parts through to the model untouched rather than JSON-stringifying them. Failures appear here too (not swallowed).

## When the step budget runs out

A run makes at most `maxSteps` model calls inside the loop. When that many pass and the model is still asking for tools, `onMaxSteps` decides:

- `throw` (default) — the invocation fails with `ERR_AGENT_MAX_STEPS`.
- `return` — the last turn is handed back as it stands: its text (often empty, since the model was asking for a tool) and its `finishReason`.
- `conclude` — the agent makes **one more** model call, beyond `maxSteps`, and returns its answer. That call declares the same tools — so the tool calls already in the conversation stay valid — but may not use one (`toolChoice: none`), and its last message is `conclusionPrompt` as a user turn. If the model returns a tool call anyway, it is not run and not recorded. The call is one more entry in `steps`, and its usage is in the total.

`return` and `conclude` both set `limit: max-steps` on the output, which is how a caller tells a budget-ended run from one the model finished — `finishReason` stays the model's own reason. A converged run carries no `limit`.

```yaml
kind: Ai.Agent
metadata: { name: Assistant }
model: !ref Gpt4oMini
maxSteps: 12
onMaxSteps: conclude
conclusionPrompt: |
  You are out of steps. Say what you finished, what is left, and the next step.
toolProviders:
  - provider: !ref WorkspaceTools
```

`conclusionPrompt` without `onMaxSteps: conclude` is refused by `telo check` (resource rule `AI_CONCLUSION_PROMPT_UNUSED`) and when the agent is created: the prompt is only ever sent by the concluding call.

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
