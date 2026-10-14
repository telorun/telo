---
description: "AiMcp.PromptToolProvider: offers every prompt an MCP server lists (any Mcp.Client) to an Ai.Agent as a tool, rendered with prompts/get when the model calls it."
sidebar_label: AiMcp.PromptToolProvider
---

# `AiMcp.PromptToolProvider`

> Examples assume aliases `Ai` (`@telorun/ai`), `AiMcp` (`@telorun/ai-mcp`) and `Mcp` (`@telorun/mcp-client`).

`AiMcp.PromptToolProvider` wraps any `Mcp.Client` as an [`Ai.ToolProvider`](../../ai/docs/ai-tool-provider.md) over the server's **prompts**: every prompt the server lists becomes a tool an [`Ai.Agent`](../../ai/docs/ai-agent.md) can call, and a call renders the prompt and hands its messages back to the model. A server's prompt catalogue — guides, templates, canned instructions — reaches the model on demand, and a prompt the server adds later reaches it with no manifest change.

## Listing — `prompts/list`

The provider sends `prompts/list` and follows `nextCursor` until a page carries none, reading at most 100 pages (a listing that has not ended by then is refused). The result is judged here rather than by the transport: `Mcp.HttpClient` and `Mcp.StdioClient` both hand it over as the server sent it, so a malformed answer fails the same way over either. Each prompt becomes one tool:

| Tool          | From the prompt                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------- |
| `name`        | the prompt's `name` (behind the agent entry's `prefix`, when one is set)                        |
| `description` | the prompt's `description`; absent when the prompt has none                                     |
| `parameters`  | `{ type: object, properties, required, additionalProperties: false }` — see below               |

`properties` holds one `{ type: string }` property per prompt argument, carrying the argument's `description` when it has one; `required` lists the arguments marked `required: true` and is left out when none is. A prompt with no arguments is `{ type: object, properties: {}, additionalProperties: false }`. MCP prompt arguments are strings, so the model is offered exactly the arguments the server declares, as strings, and nothing else.

## Calling — `prompts/get`

A model's call sends `prompts/get` with `{ name, arguments }` — the call's arguments as given — and returns the `content` block of every returned message, **in order**. Roles are not carried: a tool result has one author. The blocks are translated into [Ai content parts](../../ai/docs/ai-model.md) exactly as [`AiMcp.ToolProvider`](./ai-mcp-tool-provider.md) translates a tool's content — a text block stays a text part, an image block becomes an image part with `mimeType` renamed to `mediaType`, and a result holding any other block kind (an embedded resource, audio, …) is passed through untouched for the agent to serialize. The result passes through the agent's `maxToolResultBytes` like any tool result.

## Failures

| Code                    | When                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ERR_MCP_PROTOCOL`      | A `prompts/list` page without a `prompts` array, a prompt without a string `name`, `arguments` that are not a list of named arguments, a `nextCursor` that is not a string or repeats one already followed, a listing that has not ended after 100 pages; a `prompts/get` result without a `messages` array, or a message without a `content` block. Never read as an empty answer. |
| `ERR_INVOKE_CANCELLED`  | The agent's turn was cancelled while a `prompts/get` was in flight. The call runs under the turn's context, which is handed to the `Mcp.Client` — so a client that honours cancellation aborts the request — and is abandoned the moment the turn is cancelled whether or not the client does. That ends the agent under either `onToolError`. |
| the client's `ERR_MCP_*` | Passed through unchanged — a server offering no prompts typically answers `prompts/list` with a JSON-RPC error, which is `ERR_MCP_JSON_RPC_ERROR`. |

A failure while listing fails the agent's run, since listing happens when the agent assembles its tools. A failure of a call is a tool failure: fed back to the model or raised, as the agent's `onToolError` says. The provider asks for no approval (`toolRequiresApproval` is not implemented); gate calls with the agent entry's `approval:` when they need one.

## Example

```yaml
kind: Mcp.HttpClient
metadata: { name: hub }
url: https://mcp.example.com/mcp
clientInfo: { name: my-app, version: 1.0.0 }
---
kind: Ai.Agent
metadata: { name: assistant }
model: !ref gpt4o
toolProviders:
  - provider:
      kind: AiMcp.PromptToolProvider
      client: !ref hub
    prefix: guide_                       # → guide_<prompt name>
```

## Manifest fields

| Field    | Type               | Required | Purpose                                                    |
| -------- | ------------------ | -------- | ---------------------------------------------------------- |
| `client` | ref (`Mcp.Client`) | yes      | Any `Mcp.Client` (`Mcp.HttpClient`, `Mcp.StdioClient`, …). |

The prompt set is **statically opaque** — known only at run time, as the server lists it. `prefix` / `include` / `exclude` / `approval` live on the consuming [`Ai.Agent`](../../ai/docs/ai-agent.md)'s `toolProviders` entry.
