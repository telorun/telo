---
description: "Ai.Agent: a tool-use loop over any Ai.Model. Tool providers, maxSteps/onMaxSteps/onToolError, invocation inputs and the steps trace."
sidebar_label: Ai.Agent
---

# `Ai.Agent`

> Examples assume aliases `Ai` (this module), `AiOpenai` (`ai-openai`), and `Js` (`javascript`). Substitute if you import under different names.

`Ai.Agent` is a `Telo.Invocable` that runs a **tool-use loop** over any `Ai.Model`: it calls the model with a set of tools, executes whatever tools the model requests, replays the results, and repeats until the model produces a final answer (or a step cap is hit). The loop lives in the controller — not the provider — so it is provider-agnostic and every turn is observable in the returned `steps` trace.

Tools come from one field, `toolProviders`: a list of references to any [`Ai.ToolProvider`](./ai-tool-provider.md). Both a static list ([`Ai.Tools`](./ai-tool-provider.md#aitools)) and runtime MCP discovery (`AiMcp.ToolProvider`, from `@telorun/ai-mcp`) are providers — the agent treats them uniformly.

```yaml
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o-mini
apiKey: "${{ secrets.openaiApiKey }}"
---
kind: Js.Script
metadata: { name: Multiplier }
code: |
  function main({ a, b }) { return { product: a * b }; }
---
kind: Ai.Tools
metadata: { name: LocalTools }
tools:
  - tool: { kind: Js.Script, name: Multiplier }
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
model: { kind: AiOpenai.OpenaiModel, name: Gpt4o }
system: "Use tools when helpful."
maxSteps: 8
toolProviders:
  - provider: { kind: Ai.Tools, name: LocalTools }
```

## Manifest fields

| Field           | Type            | Required | Purpose                                                                                  |
| --------------- | --------------- | -------- | ---------------------------------------------------------------------------------------- |
| `model`         | ref (`Ai.Model`)| yes      | The LLM that drives the loop.                                                            |
| `system`        | string          | no       | Default system prompt. Runtime `inputs.system` wins.                                     |
| `options`       | object          | no       | Option overrides passed to the model each turn (merged under `inputs.options`).          |
| `maxSteps`      | integer         | no       | Max model turns. Default `8`.                                                            |
| `onMaxSteps`    | `throw\|return` | no       | At the cap without finishing: `throw` raises `ERR_AGENT_MAX_STEPS`; `return` hands back the last turn's text (`finishReason: tool-calls`). Default `throw`. |
| `onToolError`   | `feedback\|throw`| no      | When a tool throws or the model names an unknown tool: `feedback` records it in `steps` and returns it to the model so it can recover; `throw` aborts. Default `feedback`. |
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
- `steps` — one entry per turn that called tools: `{ text, toolCalls, toolResults }`, where each result carries `{ toolCallId, name, content, error? }`. Failures appear here too (not swallowed).

## See also

- [`Ai.ToolProvider` / `Ai.Tools`](./ai-tool-provider.md) — the tool contract and the static-list provider.
- [`Ai.Text`](./ai-text.md) — single-turn buffered call (no tools).
