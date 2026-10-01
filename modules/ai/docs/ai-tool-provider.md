---
description: "Ai.ToolProvider: the abstract every agent tool source implements (listTools + callTool), and Ai.Tools, the built-in static-list provider wrapping any Telo.Invocable, with typed caller context for its tools."
sidebar_label: Ai.ToolProvider
---

# `Ai.ToolProvider` & `Ai.Tools`

> Examples assume aliases `Ai` (this module) and `Js` (`javascript`).

## `Ai.ToolProvider`

`Ai.ToolProvider` is a `Telo.Abstract` (`capability: Telo.Mount`) — the single contract every source of agent tools implements. An [`Ai.Agent`](./ai-agent.md) *mounts* providers the same way an `Http.Server` mounts `Http.Api`s, then drives them through two runtime-instance methods:

```ts
interface AiToolProviderInstance {
  listTools(): Promise<ToolDescriptor[]> | ToolDescriptor[]; // { name, description?, parameters }
  callTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: InvokeContext,
    context?: Record<string, unknown>,
  ): Promise<unknown>;
  // Optional: the same call, with the tool's own result beside what the model is told.
  callToolWithOutput?(
    name: string,
    args: Record<string, unknown>,
    ctx?: InvokeContext,
    context?: Record<string, unknown>,
  ): Promise<{ output: unknown; result: unknown }>;
}
```

The agent calls `listTools()` to learn what to advertise to the model and `callTool()` to dispatch a model-requested call. `ctx` is the context of the call's `execute_tool` span, opened on the agent run's context: a provider hands it to whatever runs the tool, so cancelling the agent's turn stops the tool, and whatever the tool dispatches nests under the span. A provider that maps a tool's result into what the model sees implements `callToolWithOutput` too, so the agent can report the unmapped result as the stream part's `toolResult.output`; without it, the one value `callTool` returns is both. `context` is the agent's `context` input — data its caller passed for the tools to read, never shown to the model; a provider whose tools take none ignores it. A tool that ends because of that cancellation (`ERR_INVOKE_CANCELLED`) or suspends a durable run (`ERR_DURABLE_SUSPENDED`) ends the agent too, whatever its `onToolError` says. It never learns which concrete provider it has — so MCP, a static list, or a future OpenAPI/registry source all compose without the agent changing.

`callTool` may return a plain value (written back to the model as plain JSON — a CEL value JSON has no form for in its plain encoding, such as a duration as `"5400s"` or a timestamp as RFC 3339 text in UTC), a string, or **multimodal content parts** — a `ContentPart[]` (`{ type: "text", text }` and/or `{ type: "image", data, mediaType }`). When a tool answers with content parts the agent carries them through the `tool` message untouched, so a vision tool can hand the model an image. An image part's `data` is raw bytes (`Uint8Array`, what a rasterizer/overlay tool result produces) or a base64 string; provider translation normalizes either to its wire shape.

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

### Fields

| Field         | Type                | Required | Purpose                                                                          |
| ------------- | ------------------- | -------- | -------------------------------------------------------------------------------- |
| `contextType` | type (`!ref`, or inline) | no  | The shape of the caller data the tools' `inputs:` read as `context` — see [Caller context](#caller-context). |
| `tools`       | array               | yes      | The tools, below.                                                                |

### `tools[]` fields

| Field         | Type                   | Required | Purpose                                                                          |
| ------------- | ---------------------- | -------- | -------------------------------------------------------------------------------- |
| `tool`        | ref (`Telo.Invocable` \| `Telo.Runnable`) | yes | Any invocable or runnable — `Js.Script`, `Http.Client.Request`, `Sql.Selection`, another `Ai.Text`, a `Run.Sequence` pipeline, … |
| `name`        | string                 | no       | Tool name the model sees. Defaults to the referenced resource name.              |
| `description` | string                 | no       | What the tool does (the model reads this).                                       |
| `parameters`  | JSON Schema            | yes      | The schema the model produces arguments against.                                 |
| `inputs`      | CEL object             | no       | Maps the model's `arguments`, and the caller's `context`, into the invocable's input. Omit to forward `arguments` verbatim. |
| `result`      | CEL                    | no       | Shapes the invocable's `result` into the value fed back — a string, or content parts (`{ type: "image", data: result.image, mediaType: result.mediaType }`) to hand the model an image. Omit to write the output as plain JSON. |

By default the model's arguments forward straight to the tool — under the agent's `execute_tool` span context, so cancelling the turn cancels the tool — and the output is written back to the model as plain JSON.

Each call is dispatched through the kernel's traced dispatch, exactly as an `Http.Api` route dispatches its handler: the tool resource has its own dispatch span (nested under `execute_tool`, carrying any `x-telo-span-attribute` its contract marks) and emits its `<name>.Invoked` / `InvokeRejected` / `InvokeFailed` events like any other dispatch. `Ai.Tools` implements `callToolWithOutput`: the tool's result before `result:` is the stream part's `output`. The optional `inputs:`/`result:` mappings bridge invocables whose call shape differs from what the model produces:

```yaml
tools:
  - tool: !ref Greeter     # main({ target })
    name: greet
    parameters:
      type: object
      properties: { who: { type: string } }
      required: [who]
    inputs:
      target: !cel "arguments.who"              # model `who` → invocable `target`
    result: !cel "result.greeting"              # shape output into a string
```

Inside `inputs:`, the `arguments` variable is typed from the entry's `parameters` and `context` from the provider's `contextType`; inside `result:`, the `result` variable is typed from the invocable's declared output type when it has one (otherwise open). `parameters` is always declared explicitly — it is not derived from the invocable's `inputType`, because most invocables don't declare one.

### Caller context

A tool often needs something the model must not choose — the id of the turn it is serving, the signed-in user. The agent's caller passes that as the agent's `context` input, and a tool's `inputs:` mapping reads it as `context`, beside `arguments`. The provider declares the shape it reads once, as `contextType`:

```yaml
kind: Ai.Tools
metadata: { name: WorkspaceTools }
contextType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [turnId]
    properties:
      turnId: { type: string }
tools:
  - tool: !ref WriteFile
    name: write_file
    parameters:
      type: object
      required: [path, content]
      properties: { path: { type: string }, content: { type: string } }
    inputs:
      path: !cel "arguments.path"
      content: !cel "arguments.content"
      turnId: !cel "context.turnId"      # from the agent's caller, not the model
```

`contextType` takes the forms an `outputType` does — a `!ref` to a named `Telo.JsonSchema`, or an inline one. It does two things:

- **It types `context` inside `inputs:`.** `context.turnId` type-checks against it, and a misspelled field is `CEL_UNKNOWN_FIELD`. With no `contextType`, `context` is an empty object, so reading any field of it is `CEL_UNKNOWN_FIELD` at the mapping — caller data is declared before it is read.
- **It becomes part of every agent mounting the provider.** The agent's `context` input must satisfy it ([`Ai.Agent` → Caller context](./ai-agent.md#caller-context)), so a call that leaves `turnId` out is refused before the model is asked anything rather than failing inside a tool.

The model-visible `parameters` are unchanged: `context` never appears in what the model is told.

## See also

- [`Ai.Agent`](./ai-agent.md) — the loop that consumes providers.
- [`AiMcp.ToolProvider`](../../ai-mcp/docs/ai-mcp-tool-provider.md) — discover an MCP server's tools.
