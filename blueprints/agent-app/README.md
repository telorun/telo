# AgentApp

An AI assistant served over HTTP, from one declaration. Pick the model, write
what the assistant is told, list the tools it may call; the chat endpoints, the
conversation store and the tool-use loop come with the blueprint.

```yaml
imports:
  AgentApp: oci://ghcr.io/telorun/blueprints/agent-app@<version>
  OpenAI: oci://ghcr.io/telorun/openai@<version>
targets:
  - !ref assistant
---
kind: AgentApp.App
metadata:
  name: assistant
port: 8854
model: !ref gpt4oMini
system: You are the support assistant of a small online shop.
tools:
  - tool: !ref orderStatus
    name: order_status
    description: Where an order is, by its order number.
    parameters:
      type: object
      required: [orderId]
      properties:
        orderId: { type: string }
```

## Fields

| Field | Meaning |
|---|---|
| `port` | TCP port the server listens on. |
| `title` | Title of the generated OpenAPI document (default `Assistant`). |
| `model` | The model that answers — any `Ai.Model` implementation, declared inline or as `!ref`. |
| `system` | What the assistant is told before every conversation. |
| `tools` | What the assistant may call. Each entry is an `Ai.Tools` entry: `tool` (any invocable), `name`, `description`, `parameters` (JSON Schema of the arguments), and optional `inputs` / `result` mappings. Default: none. |
| `maxSteps` | How many model turns one message may take, tool calls included (default `8`). A message that needs more fails with `ERR_AGENT_MAX_STEPS`. |
| `history` | SQLite file the conversations are kept in (default `.telo/conversations.sqlite`). |

## Endpoints

| Endpoint | Answer |
|---|---|
| `POST /conversations/{id}/messages` | `200 { reply }` for `{ message }`. The message is stored, the assistant answers from the whole conversation so far, and its reply is stored too. An empty message is `400`. |
| `GET /conversations/{id}/messages` | `200 { messages }` — the conversation's `{ role, content }` turns, oldest first; empty for an id never used. |

A conversation is whatever id the caller picks: two ids never see each other's
messages, and a conversation survives restarts. Tool calls and their results are
part of one answer and are not stored as turns of their own.

## What it builds

An `Ai.Agent` over `model` with the tools mounted, a SQLite database holding
every conversation's turns (its table created before the server starts), and
one `Http.Server` on `port` serving the two endpoints with an OpenAPI document
titled `title`.

See [`example/`](./example/telo.yaml) for a shop assistant on OpenAI and
[`tests/`](./tests) for the endpoints driven over a model that echoes.
