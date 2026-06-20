---
description: "Ai.ToolProvider: the abstract every agent tool source implements (listTools + callTool), and Ai.Tools, the built-in static-list provider wrapping any Telo.Invocable."
sidebar_label: Ai.ToolProvider
---

# `Ai.ToolProvider` & `Ai.Tools`

> Examples assume aliases `Ai` (this module) and `Js` (`javascript`).

## `Ai.ToolProvider`

`Ai.ToolProvider` is a `Telo.Abstract` (`capability: Telo.Mount`) — the single contract every source of agent tools implements. An [`Ai.Agent`](./ai-agent.md) *mounts* providers the same way an `Http.Server` mounts `Http.Api`s, then drives them through two runtime-instance methods:

```ts
interface AiToolProviderInstance {
  listTools(): Promise<ToolDescriptor[]> | ToolDescriptor[]; // { name, description?, parameters }
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}
```

The agent calls `listTools()` to learn what to advertise to the model and `callTool()` to dispatch a model-requested call. It never learns which concrete provider it has — so MCP, a static list, or a future OpenAPI/registry source all compose without the agent changing.

`callTool` may return a plain value (JSON-stringified back to the model), a string, or **multimodal content parts** — a `ContentPart[]` (`{ type: "text", text }` and/or `{ type: "image", data, mediaType }`). When a tool answers with content parts the agent carries them through the `tool` message untouched, so a vision tool can hand the model an image. An image part's `data` is raw bytes (`Uint8Array`, what a rasterizer/overlay tool result produces) or a base64 string; provider translation normalizes either to its wire shape.

Implementing one: declare `capability: Telo.Mount, extends: Ai.ToolProvider` (use `Self.ToolProvider` from inside `@telorun/ai` itself) and return an instance exposing `listTools`/`callTool`. Two ship today — `Ai.Tools` (below) and [`AiMcp.ToolProvider`](../../ai-mcp/docs/ai-mcp-tool-provider.md).

## `Ai.Tools`

`Ai.Tools` is the built-in provider: a **static list** of tools, each wrapping any `Telo.Invocable` **or** `Telo.Runnable`. A `Run.Sequence` (a Runnable with callable inputs/outputs) can wrap a multi-step pipeline — fetch → render → annotate → return an image — as one tool the model calls.

```yaml
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
```

### `tools[]` fields

| Field         | Type                   | Required | Purpose                                                                          |
| ------------- | ---------------------- | -------- | -------------------------------------------------------------------------------- |
| `tool`        | ref (`telo#Invocable` \| `telo#Runnable`) | yes | Any invocable or runnable — `Js.Script`, `Http.Client.Request`, `Sql.Selection`, another `Ai.Text`, a `Run.Sequence` pipeline, … |
| `name`        | string                 | no       | Tool name the model sees. Defaults to the referenced resource name.              |
| `description` | string                 | no       | What the tool does (the model reads this).                                       |
| `parameters`  | JSON Schema            | yes      | The schema the model produces arguments against.                                 |
| `inputs`      | CEL object             | no       | Maps the model's `arguments` into the invocable's input. Omit to forward verbatim. |
| `result`      | CEL                    | no       | Shapes the invocable's `result` into the value fed back — a string, or content parts (`{ type: "image", data: result.image, mediaType: result.mediaType }`) to hand the model an image. Omit to JSON-stringify the output. |

By default the model's arguments forward straight to `invoke()` and the output is JSON-stringified back to the model. The optional `inputs:`/`result:` mappings bridge invocables whose call shape differs from what the model produces:

```yaml
tools:
  - tool: !ref Greeter     # main({ target })
    name: greet
    parameters:
      type: object
      properties: { who: { type: string } }
      required: [who]
    inputs:
      target: "${{ arguments.who }}"              # model `who` → invocable `target`
    result: "${{ result.greeting }}"              # shape output into a string
```

Inside `inputs:`, the `arguments` variable is typed from the entry's `parameters`; inside `result:`, the `result` variable is typed from the invocable's declared output type when it has one (otherwise open). `parameters` is always declared explicitly — it is not derived from the invocable's `inputType`, because most invocables don't declare one.

## See also

- [`Ai.Agent`](./ai-agent.md) — the loop that consumes providers.
- [`AiMcp.ToolProvider`](../../ai-mcp/docs/ai-mcp-tool-provider.md) — discover an MCP server's tools.
