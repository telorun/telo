---
description: "Ai.Text: single-turn buffered LLM call. Manifest fields, invocation inputs (prompt vs messages, system override, options), output shape, and Run.Sequence integration."
sidebar_label: Ai.Text
---

# `Ai.Text`

> Examples below assume this module is imported with an `imports:` entry under alias `Ai` (and `openai` as `OpenAI`). Kind references (`Ai.Text`, `OpenAI.ChatModel`, …) follow those aliases — if you import either module under a different name, substitute accordingly.

`Ai.Text` is a `Telo.Invocable` that delegates a single-turn, buffered LLM call to any `Ai.Model` implementation. It owns message-building, system-prompt handling, and option-merging; the model handles the HTTP call. For chunked output, see [Ai.TextStream](./ai-text-stream.md).

```yaml
kind: Telo.Application
metadata: { name: summarizer, version: 1.0.0 }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.10.0
  OpenAI: oci://ghcr.io/telorun/openai@0.3.0
  Http: oci://ghcr.io/telorun/http-client@0.22.0
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
model: gpt-4o
request: !ref openaiRequest
---
kind: Ai.Text
metadata: { name: Summarizer }
model: !ref Gpt4o
system: "Summarize in one sentence."
options:
  temperature: 0.2
```

---

## Manifest fields

| Field     | Type   | Required | Purpose                                                                              |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `model`   | ref    | yes      | Reference to any `Ai.Model` implementation. Typed `x-telo-ref: Self.Model`.      |
| `system`  | string | no       | Default system prompt. Runtime `inputs.system` wins when set.                        |
| `options` | object | no       | Resource-level option defaults. Merged beneath `inputs.options` (downstream wins).   |

The `model` field uses identity-form `x-telo-ref` because the schema is part of `@telorun/ai`'s public surface — it must resolve regardless of who imports it. (`extends`, by contrast, uses alias-form because it's evaluated in the declaring file's own import scope. See `kernel/docs/inheritance.md`.)

## Invocation inputs

| Field      | Type   | Required                       | Purpose                                                            |
| ---------- | ------ | ------------------------------ | ------------------------------------------------------------------ |
| `prompt`   | string | exactly one of prompt/messages | Shorthand; wraps to `messages: [{role: "user", content: prompt}]`. |
| `messages` | array  | exactly one of prompt/messages | Full turns, each `{role, content}`; `content` is a string or [content parts](./ai-model.md#modality-lives-in-the-parts). |
| `system`   | string | no                             | Runtime system override. Wins over manifest `system`.              |
| `options`  | object | no                             | Per-call option overrides.                                         |

Validation comes from two places. The **shape** of the call — each message's fields, and what every content part must carry — is the declared input type's: a malformed literal is `CONTRACT_INPUTS_MISMATCH` under `telo check`, a malformed computed value `ERR_INPUT_INVALID` at dispatch. What the shape cannot state is `ERR_INVALID_INPUT`: both `prompt` and `messages`, neither, an empty message list, or a `tool` turn.

A multimodal turn is a list of parts:

```yaml
inputs:
  messages:
    - role: user
      content:
        - { type: text, text: "Describe this picture." }
        - { type: image, mediaType: image/jpeg, uri: "https://example.com/cat.jpg" }
```

Whether the model can take a given part is the model's to say — see [Errors](#errors).

## Output

```ts
{
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number; // the part of promptTokens read from a cache
    reasoningTokens?: number;    // the part of completionTokens spent reasoning
    unit: string;                // "tokens"
    total: number;
  };
  finishReason: "stop" | "length" | "content-filter" | "tool-calls" | "other";
}
```

`cachedPromptTokens` and `reasoningTokens` are present when the model reports them and absent otherwise; absent is not zero.

The model's answer is held to `Ai.Model`'s declared output by the kernel (`ERR_OUTPUT_INVALID`); a token count that is not a representable integer is `ERR_CONTRACT_VIOLATION`.

## Errors

`Ai.Text` throws its own codes — `ERR_INVALID_INPUT`, `ERR_INVALID_REFERENCE`, `ERR_CONTRACT_VIOLATION` — **and whatever its model throws**, unchanged. The kind declares `throws: { inherit: true }`, so the model's declared codes are part of this resource's own throw union: a `catch:` step or a route's `catches:` may name them, and `telo check` asks for every one to be covered.

```yaml
routes:
  - request: { path: /describe, method: POST }
    handler: !ref Describer          # an Ai.Text over an OpenAI.ChatModel
    inputs:
      messages: !cel "request.body.messages"
    returns:
      - status: 200
        content: { application/json: { body: { text: !cel "result.text" } } }
    catches:
      - when: !cel "error.code == 'ERR_CONTENT_UNSUPPORTED'"
        status: 422
        content:
          application/json:
            body: { unsupported: !cel "error.data.partType" }
      - status: 502    # every other code the operation and its model declare
        content: { application/json: { body: { code: !cel "error.code" } } }
```

A list that names some of the codes and has no catch-all is `UNCOVERED_THROW_CODE`, listing what is left — the model's codes included.

## Option layering

Four conceptual layers, three of them user-visible. Shallow merge; downstream wins.

| # | Source                                  | When merged                                          |
| - | --------------------------------------- | ---------------------------------------------------- |
| 0 | Provider hard defaults (controller)     | Inside the provider, before vendor call.             |
| 1 | `Ai.<Provider>Model.options` (manifest) | Inside the provider, on top of layer 0.              |
| 2 | `Ai.Text.options` (manifest)            | Inside the Ai.Text controller, before delegating.    |
| 3 | `inputs.options` at invocation time     | Inside the Ai.Text controller, on top of layer 2.    |

The provider receives layers 2+3 as the `options` bag and merges layers 0+1 internally.

## System-prompt rules

```text
runtime inputs.system  >  manifest system  >  inline messages[0] when role: system
```

If the messages array already starts with `role: system`, a runtime/manifest system **replaces** that message's content. Otherwise the system message is **prepended**. Either way, exactly one system message ends up in the canonical messages array.

## Run.Sequence integration

`Ai.Text` is a regular Invocable, so it slots straight into `Run.Sequence`:

```yaml
kind: Run.Sequence
metadata: { name: SummarizeArticle }
steps:
  - name: Summarize
    inputs:
      prompt: !interpolate "Summarize:\n${{ vars.articleText }}"
    invoke: !ref Summarizer
  - name: Save
    inputs:
      summary: !cel "steps.Summarize.result.text"
    invoke:
      kind: Sql.Command
      connection: !ref Db
      inputs:
        sql: "INSERT INTO summaries (text) VALUES (?)"
        bindings: [!cel "inputs.summary"]
```

`steps.Summarize.result.{text,usage,finishReason}` is fully typed — the analyzer derives it from `Ai.Text`'s own declared `outputType`.

## What's NOT here

- **Streaming.** `Ai.Text` is buffered; chunked output lives in [Ai.TextStream](./ai-text-stream.md), which shares the same provider resources via `Ai.Model`.
- **Tool use / function calling.** Lives in [Ai.Agent](./ai-agent.md) and [Ai.AgentStream](./ai-agent-stream.md).
