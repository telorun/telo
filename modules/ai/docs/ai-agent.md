---
description: "Ai.Agent: a tool-use loop over any Ai.Model. Tool providers, typed caller context, tool approval (gated calls, an approver, interrupt and resume), the recorded messages, the step budget (maxSteps/onMaxSteps/conclusionPrompt), onToolError, bounded tool results, invocation inputs, the steps and the settled tool results."
sidebar_label: Ai.Agent
---

# `Ai.Agent`

> Examples assume aliases `Ai` (this module), `OpenAI` (`openai`), `Http` (`http-client`), and `Js` (`javascript`). Substitute if you import under different names.

`Ai.Agent` is a `Telo.Invocable` that runs a **tool-use loop** over any `Ai.Model`: it calls the model with a set of tools, executes whatever tools the model requests, replays the results, and repeats until the model produces a final answer (or a step cap is hit). The loop lives in the controller — not the provider — so it is provider-agnostic and every model call is observable in the returned `steps`, and every settled tool call in `toolResults`.

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
| `system`        | string or text parts | no  | Default system prompt — a string, or a non-empty list of text parts when one marks a [prompt-cache breakpoint](../README.md#prompt-caching). Runtime `inputs.system` wins. In this field a text part is exactly `{ type: text, text, cacheBreakpoint? }`; any other key is refused. |
| `options`       | object          | no       | Option overrides passed to the model each turn (merged under `inputs.options`).          |
| `maxSteps`      | integer         | no       | Max model turns. Default `8`. May be computed (`!cel "variables.maxSteps"`), resolved once at startup. |
| `onMaxSteps`    | `throw\|return\|conclude` | no | At the cap without finishing — see [When the step budget runs out](#when-the-step-budget-runs-out). Default `throw`. |
| `conclusionPrompt` | string (markdown) | no  | The final user message of the concluding call. Only with `onMaxSteps: conclude`; has a default wrap-up text. |
| `onToolError`   | `feedback\|throw`| no      | When a tool throws or the model names an unknown tool: `feedback` records it in `toolResults` (`error: true`) and returns it to the model so it can recover, while the tools running beside it finish; `throw` aborts with the first failure and cancels the tools still running. Default `feedback`. A cancelled invocation and a durable suspension are not tool errors: they propagate either way. |
| `maxParallelTools` | integer ≥ 1 | no | How many of one model response's tool calls run at once — see [Tools run side by side](#tools-run-side-by-side). Default `4`. May be computed, resolved once at startup. |
| `maxToolResultBytes` | integer ≥ 1 | no | Bounds the text each tool result feeds the model — see [Bounded tool results](#bounded-tool-results). Unset: unbounded. |
| `toolProviders` | array           | no       | Tool sources — see below.                                                                |
| `approver`      | object          | no       | What decides a tool call that needs a decision — see [Tool approval](#tool-approval).    |

### `toolProviders[]`

| Field      | Type                  | Required | Purpose                                                       |
| ---------- | --------------------- | -------- | ------------------------------------------------------------- |
| `provider` | ref (`Ai.ToolProvider`)| yes     | A static list, MCP server, or any provider.                   |
| `prefix`   | string                | no       | Namespaces this provider's tool names (avoids collisions).    |
| `include`  | string[]              | no       | Allowlist of bare tool names to expose.                       |
| `exclude`  | string[]              | no       | Denylist of bare tool names.                                  |
| `approval` | `{ include?, exclude? }` | no    | Which of the entry's tools need a decision before they run — see [Tool approval](#tool-approval). |

Tools are listed lazily on first invoke and cached. A name clash across providers that a `prefix` doesn't resolve is `ERR_AGENT_TOOL_COLLISION`.

## Invocation inputs

| Field      | Type   | Required                          | Purpose                                                      |
| ---------- | ------ | --------------------------------- | ------------------------------------------------------------ |
| `prompt`   | string | exactly one of `prompt`/`messages`| Shorthand for `messages: [{ role: user, content: prompt }]`. |
| `messages` | array  | exactly one of `prompt`/`messages`| Full turns.                                                  |
| `system`   | string or text parts | no                  | Runtime system override, in either form (wins over manifest `system`). A text part here is read as a message's is. |
| `options`  | object | no                                | Per-call option overrides.                                   |
| `context`  | object | no                                | Data from the caller for the tools to read — see [Caller context](#caller-context). Default `{}`. |
| `approvals` | array | no                                | Decisions on the tool calls `messages` leaves pending: `{ toolCallId, approved, reason? }` each. An `approvals` entry beside `prompt` is refused — see [Resuming](#resuming-a-run-that-ended-asking). |
| `providerState` | any | no                              | Opaque state a previous run returned as `providerState`; handed to the first model call. |

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

`{ text, usage, finishReason, limit?, steps, toolResults, messages, interrupt?, approvalRequests?, approvalDecisions?, providerState? }`:

- `text` — the model's final answer. On a run that [ends asking](#when-the-run-ends-asking) it is the text of the assistant turn that asked, often empty; a resumed run that ends asking again before making any model call returns an empty string.
- `usage` — token usage summed across every model call in the loop. `cachedPromptTokens` (the part of `promptTokens` read from a cache), `cacheWritePromptTokens` (the part written to one) and `reasoningTokens` (the part of `completionTokens` spent reasoning) are summed the same way when the model reports them, and absent when no call did — absent is not zero.
- `finishReason` — from the final turn.
- `limit` — `max-steps` when the step budget ended the run (`onMaxSteps: return` or `conclude`); absent when the model finished on its own.
- `steps` — one entry per model call the run made, the answering and the concluding call included: `{ text, toolCalls }`. A run that [resumes](#resuming-a-run-that-ended-asking) pending calls adds no entry for them. A call's id is fixed when the model requests it — a model that supplies none gets a generated `call_<uuid>`, unique across runs — and its result's `toolCallId` and the replayed assistant message carry the same one. The number of entries is the run's `ai.agent.steps`.
- `toolResults` — one entry per tool call the run settled — ran, failed or was denied — including calls a previous run left pending, in the order they were recorded: `{ toolCallId, name, content, error?, denied? }`. A call still waiting has none and is listed in `approvalRequests`. `content` is what the model was told — a string, or **content parts** (`ContentPart[]`) when a tool answered with an image; the agent carries parts through to the model untouched rather than JSON-stringifying them. A failure is listed here with `error: true` (not swallowed), and a call that was decided against and never ran with `denied: true`. Empty when the run settled none.

- `messages` — every message the run appended to the conversation — see [The record](#the-record).
- `interrupt` / `approvalRequests` — set when the run ended with tool calls waiting for a decision — see [When the run ends asking](#when-the-run-ends-asking).
- `approvalDecisions` — what the approver answered, `{ toolCallId, name, decision, reason? }` per call it was asked about, in the order it answered; absent when it was never asked.
- `providerState` — opaque model state to pass back as the next run's `providerState`: the last state a model call produced, or the input `providerState` when no call produced one, absent when neither.

## Errors

The agent throws its own codes — `ERR_INVALID_INPUT`, `ERR_INVALID_REFERENCE`, `ERR_CONTRACT_VIOLATION`, `ERR_AGENT_MAX_STEPS`, `ERR_AGENT_UNKNOWN_TOOL`, `ERR_AGENT_TOOL_COLLISION`, `ERR_AGENT_APPROVAL_UNKNOWN_TOOL`, `ERR_AGENT_APPROVAL_DECISION_INVALID` — **and whatever its model or its approver throws**, unchanged: the kind declares `throws: { inherit: true }`, so their declared codes are part of the agent's own throw union. Every model raises the same [thirteen codes](../README.md#catching-a-models-errors), whichever provider it is. A `catch:` step or a route's `catches:` may name them, and a list with no catch-all must cover them (`UNCOVERED_THROW_CODE`). See [Ai.Text → Errors](./ai-text.md#errors) for a route that does.

The shape of the call — its messages and their content parts included — is the declared input type's (`CONTRACT_INPUTS_MISMATCH` under `telo check`, `ERR_INPUT_INVALID` at dispatch); `ERR_INVALID_INPUT` is what the shape cannot state: both `prompt` and `messages`, or neither, and an `approvals` list that cannot be placed.

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

`conclusionPrompt` without `onMaxSteps: conclude` is refused by `telo check` (resource rule `AI_CONCLUSION_PROMPT_UNUSED`) and when the agent is created (`ERR_AI_CONCLUSION_PROMPT_UNUSED`): the prompt is only ever sent by the concluding call.

## Tool approval

A tool call can need a decision before it runs — a payment, a delete, anything a model should not do unreviewed. Such a call is **gated**: the agent does not run it until someone decides. The decision comes from the caller (a human, through `approvals`), or from an **approver** the agent names; with neither, the run ends asking.

### Which calls are gated

Two sources say so, and **either one gates a call** — neither ungates what the other gates:

- **The agent's entry**, by tool name: `toolProviders[].approval: { include?, exclude? }`, matched on bare tool names (before `prefix`) over the tools the entry exposes after its own `include` / `exclude`.

  | `approval`                    | Gated                                          |
  | ----------------------------- | ---------------------------------------------- |
  | absent                        | none                                           |
  | `{}`                          | every tool the entry exposes                   |
  | `{ include: [a, b] }`         | exactly `a` and `b` (`include: []` gates none) |
  | `{ exclude: [a] }`            | every exposed tool except `a`                  |

- **The tool's provider**, per call: an [`Ai.Tools`](./ai-tool-provider.md#approval) entry's `approval` is `true` or a CEL condition over the call's `arguments` and the caller's `context`. The provider is asked only when the name lists did not already gate the call.

```yaml
toolProviders:
  - provider: !ref BankTools          # its `transfer` tool gates itself above a limit
  - provider: !ref GithubMcp          # tools discovered at runtime
    approval: { exclude: [search_issues, get_file] }
```

**Prefer `exclude` for a provider whose tool list can change** (an MCP server): a tool it adds later is then gated until you list it, where an `include` list would let it run unreviewed. A name in `approval.include` that the entry does not expose is `ERR_AGENT_APPROVAL_UNKNOWN_TOOL` when the tools are assembled, before any model call. Over an `Ai.Tools` provider, whose tools are declared, `telo check` refuses it first: a name that is neither a tool's `name` nor, for a tool with none, the name of the resource it references is `REFERRER_RULE_VIOLATED` on the agent (rule `AGENT_APPROVAL_UNKNOWN_TOOL`, `AGENT_STREAM_APPROVAL_UNKNOWN_TOOL` on `Ai.AgentStream`) — matched bare, before any `prefix`. A provider that discovers its tools at runtime has no list to check, so there the runtime refusal is the only one. A name the entry's own `include` / `exclude` removes is refused earlier, by `telo check` (resource rule `AI_APPROVAL_NAME_FILTERED`) and when the agent is created (`ERR_AI_APPROVAL_NAME_FILTERED`). An unknown name in `approval.exclude` is ignored.

A gate that cannot be evaluated — its expression throws — is a failure of that call under `onToolError`; the tool does not run. So is a gate that answers with anything but a boolean, which is never read as "not gated": a tool's `approval` expression is refused with `ERR_PREDICATE_NOT_BOOLEAN`, and any other provider's answer with `ERR_CONTRACT_VIOLATION`.

### The approver

`approver` names one resource that decides every gated call of this agent, whichever source gated it:

| Field    | Purpose |
| -------- | ------- |
| `invoke` | Any invocable or runnable — a `!ref` or an inline declaration. Called once per gated call. |
| `inputs` | CEL mapping into its input. Two bindings: `toolCall` — `{ id, name, arguments }`, `name` as the model saw it (prefix applied) — and `tool` — `{ name, description, parameters }`, `description` an empty string when the tool declares none. Checked against the target's `inputType` (`CONTRACT_INPUTS_MISMATCH`). |
| `result` | CEL mapping from its output, bound as `result` and typed by its `outputType`, to `{ decision, reason? }`. `decision` is `approve`, `reject` or `defer`. |

The caller's `context` and the conversation are deliberately not in scope in either mapping: an approver judges the call it is shown.

- **`approve`** — the tool runs exactly as an ungated call does.
- **`reject`** — the tool is never reached. The model is told the call was denied, with `reason`, exactly as when a human refuses it.
- **`defer`** — the call stays pending and the run ends asking, exactly as with no approver.

A model as the reviewer — a text completion with its own instructions:

```yaml
kind: Ai.Agent
metadata: { name: Assistant }
model: !ref Gpt4o
toolProviders:
  - provider: !ref GithubMcp
    approval: { exclude: [search_issues, get_file] }
approver:
  invoke:
    kind: Ai.Text
    model: !ref Gpt4oMini
    system: |
      You review tool calls an assistant wants to make. Answer with one word:
      approve, reject, or defer when a person should decide.
  inputs:
    prompt: !interpolate "Tool: ${{ toolCall.name }} — ${{ tool.description }}\nArguments: ${{ json(toolCall.arguments) }}"
  result:
    decision: !cel "trim(result.text) in ['approve', 'reject'] ? trim(result.text) : 'defer'"
```

The arguments shown to the reviewer are written by the model under review, so text injected into them that tells the reviewer to "approve" is an approval: a model reviewer narrows what runs unreviewed, it is not a guarantee.

Rules instead of a model — a sequence at the same slot:

```yaml
approver:
  invoke:
    kind: Run.Sequence
    inputType:
      kind: Telo.JsonSchema
      schema:
        type: object
        properties:
          amount: { type: integer }
    steps:
      - name: verdict
        value: !cel "inputs.amount > 1000 ? 'reject' : inputs.amount > 100 ? 'defer' : 'approve'"
    outputs:
      decision: !cel "steps.verdict.result"
  inputs:
    amount: !cel "toolCall.arguments.amount"
  result:
    decision: !cel "result.decision"
```

An ask and, when it approves, the tool run it leads to hold **one** `maxParallelTools` slot back to back; asks for several gated calls run side by side up to that bound. An ask is not a step against `maxSteps`, and **the approver's own token usage is not counted** in the agent's `usage` — trace or log the approver itself to account for it.

**A failed ask fails the run, whatever `onToolError` says.** The approver throwing, or a mapping failing to evaluate, propagates unchanged — its codes are part of the agent's throw union, so a route's `catches:` may name them — and cancels the calls running beside it. An answer that is not a decision — not an object, a `decision` outside the three, a `reason` that is not a string (`null` included), or any other key — is `ERR_AGENT_APPROVAL_DECISION_INVALID` (`data: { toolCallId, name }`). The gated tool is not run. On `Ai.AgentStream` the `message` parts already emitted leave the call pending, so the run can be [resumed](#resuming-a-run-that-ended-asking) once the approver is back; `Ai.Agent` returns nothing from a rejected run, so it is run again from its input. Cancelling the invocation cancels a running approver.

**The approver's target is resolved when a run starts**, before pending calls are settled and before the first model call: an `approver.invoke` that is not a usable reference fails every run, including one in which no call is gated.

### When the run ends asking

A gated call nobody decided — no approver, or it deferred — ends the run once the response's other calls have settled:

- `interrupt: approval`, with `finishReason: tool-calls`. Never beside `limit`.
- `approvalRequests` — the waiting calls (`{ id, name, arguments }`), in call order.
- `messages` — everything the run appended: the assistant turn that asked, and the results of the calls that did run.
- `providerState` — the last state a model call produced, or the input `providerState` when no call produced one.

No model call follows an interrupt.

### Resuming a run that ended asking

Invoke an agent again — any instance with the same tools — with the conversation and the decisions:

```yaml
- name: resume
  invoke: !ref Assistant
  inputs:
    messages: !cel "steps.load.result.messages"      # stored input messages + recorded `messages`
    approvals:
      - { toolCallId: !cel "inputs.toolCallId", approved: !cel "inputs.approved", reason: !cel "inputs.reason" }
    providerState: !cel "steps.load.result.providerState"
```

The pending calls are read from `messages`: when they end with an assistant turn carrying tool calls, followed only by tool messages, the pending calls are those with no tool message. They are settled before any model call, each by the first of:

1. **A decision in `approvals`.** `approved: true` runs the call, without judging it again and without asking the approver. `approved: false` does not run it: the model is told it was denied, with `reason`, and its `toolResults` entry is marked `denied: true`. A denial is not a tool error and ignores `onToolError`.
2. **The approver**, when the call is still gated and no decision was given.
3. **Another interrupt**, when the call is still gated and nobody decided. A pending call that is not gated simply runs.

**A human decision wins**: a call named in `approvals` never reaches the approver. And **an approval does not outlive the run** — nothing is remembered between invocations, so a call the approver approved whose tool did not finish is pending on the next run and is asked about again. A call whose tool message exists is never asked about again.

`ERR_INVALID_INPUT` — decided from the input alone, before anything runs — for a decision naming a call that is not pending, two decisions for one call, two pending calls sharing an id, and an `approvals` entry beside `prompt`.

**Resuming trusts `messages`.** The tool that runs, and the arguments it runs with, are the ones in the assistant turn you pass back — the agent has no memory of what it asked. Load the conversation from your own store, keyed by something the caller cannot forge, and take only the decision (`toolCallId`, `approved`, `reason`) from the request. A conversation echoed back by a browser would let its user rewrite the arguments they are "approving".

## The record

`messages` on the output is every message the run appended to the conversation, in the order it appended them: each assistant turn, each tool result, the final answer. **The input messages followed by `messages` is the conversation to persist and to pass to the next run** — after an interrupt and after an ordinary answer alike. (Called with `prompt`, the input is the one user message `{ role: user, content: <prompt> }`.)

The record is append-only, so tool messages are in completion order, and a call approved on a later run lands after its siblings. That is fine to store as it is: whenever the agent builds a model request it puts each assistant turn's tool messages back into that turn's call order.

## Tools run side by side

When one model response asks for several tools, the agent runs them concurrently, up to `maxParallelTools` (default `4`). Calls start in the order the model asked for them; the model is given their results **in that same order**, whatever order they complete in. `toolResults` lists them in the order they were recorded — completion order, the order of their tool messages in `messages` — so match a result to its call by `toolCallId`, never by position.

```yaml
maxParallelTools: 1
```

`1` runs one call at a time, in call order. Set it when the tools of one response depend on each other's side effects — a write the next call reads back, two edits of one file. Tools that only read, or that touch separate things, need nothing.

What a failure does to the calls beside it follows `onToolError`:

- **`feedback`** — the failed call becomes an error result; the calls running beside it finish, and the model sees every result.
- **`throw`** — the first failure cancels the calls still running (each observes the cancellation through its invocation context), no further call starts, and the run rejects with that failure.

Cancelling the invocation cancels every running tool. A tool that suspends a durable run does not cancel the tools beside it: they finish, no further one starts, and the suspension is then raised.

## Bounded tool results

`maxToolResultBytes` caps the UTF-8 bytes of text each tool result passes to the model, so one oversized reply (a large file, a long log) cannot fill the agent's context window. It applies to every tool whatever provider serves it — an `Ai.Tools` entry and an MCP tool alike — and to error results (`Error: …`) as well as successful ones. Only text is measured:

- a **string** result longer than the limit keeps its longest prefix of whole characters within the limit;
- a **content-part** result counts its text parts in order: the part the limit falls in is cut at a character boundary and every later text part is dropped; media parts (images, audio, files) are neither counted nor cut and keep their positions;
- a result within the limit is passed through unchanged.

A cut result is followed by the marker, exactly:

```
[truncated: <omitted> of <total> bytes cut; a tool result passes at most <limit> bytes to the model]
```

(decimal byte counts over the text) — on its own line after the kept text for a string result, or as a final text part for a part result. The marker says what was cut, never how to get the rest: telling the model how to page through a particular tool belongs in the agent's own system prompt. The bound is per agent rather than per tool, because what it protects is the agent's context. `toolResults` records the bounded `content` — what the model saw — and [`Ai.AgentStream`](./ai-agent-stream.md#tool-results)'s `output` keeps what the tool returned whole.

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

The invocation's context reaches every model call and every tool: the agent hands it (through the call's span context) to the tool provider's `callTool`, which passes it on to whatever runs the tool. Cancelling the invocation — a step's `timeout:`, a cancelled run — stops every running tool and ends the agent with `ERR_INVOKE_CANCELLED`, under either `onToolError`. Tools running side by side share a cancellation scope of their own inside the invocation's, which is what lets one failure under `onToolError: throw` stop the others without cancelling the turn.

## See also

- [`Ai.ToolProvider` / `Ai.Tools`](./ai-tool-provider.md) — the tool contract and the static-list provider.
- [`Ai.Text`](./ai-text.md) — single-turn buffered call (no tools).
