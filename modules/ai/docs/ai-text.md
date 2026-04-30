---
description: "Ai.Text: single-turn buffered LLM call. Manifest fields, invocation inputs (prompt vs messages, system override, options), output shape, and Run.Sequence integration."
sidebar_label: Ai.Text
---

# `Ai.Text`

> Examples below assume this module is imported with `Telo.Import` alias `Ai` (and `ai-openai` as `AiOpenai`). Kind references (`Ai.Text`, `AiOpenai.OpenaiModel`, …) follow those aliases — if you import either module under a different name, substitute accordingly.

`Ai.Text` is a `Telo.Invocable` that delegates a single-turn, buffered LLM call to any `Ai.Model` implementation. It owns message-building, system-prompt handling, and option-merging; the model handles the HTTP call. For chunked output, see [Ai.TextStream](./ai-text-stream.md).

```yaml
kind: Telo.Import
metadata: { name: Ai }
source: ../modules/ai
---
kind: Telo.Import
metadata: { name: AiOpenai }
source: ../modules/ai-openai
---
kind: AiOpenai.OpenaiModel
metadata: { name: Gpt4o }
model: gpt-4o
apiKey: "${{ secrets.OPENAI_API_KEY }}"
---
kind: Ai.Text
metadata: { name: Summarizer }
model:
  kind: AiOpenai.OpenaiModel
  name: Gpt4o
system: "Summarize in one sentence."
options:
  temperature: 0.2
```

---

## Manifest fields

| Field     | Type   | Required | Purpose                                                                              |
| --------- | ------ | -------- | ------------------------------------------------------------------------------------ |
| `model`   | ref    | yes      | Reference to any `Ai.Model` implementation. Typed `x-telo-ref: "std/ai#Model"`.      |
| `system`  | string | no       | Default system prompt. Runtime `inputs.system` wins when set.                        |
| `options` | object | no       | Resource-level option defaults. Merged beneath `inputs.options` (downstream wins).   |

The `model` field uses identity-form `x-telo-ref` because the schema is part of `@telorun/ai`'s public surface — it must resolve regardless of who imports it. (`extends`, by contrast, uses alias-form because it's evaluated in the declaring file's own import scope. See `kernel/docs/inheritance.md`.)

## Invocation inputs

| Field      | Type   | Required                       | Purpose                                                            |
| ---------- | ------ | ------------------------------ | ------------------------------------------------------------------ |
| `prompt`   | string | exactly one of prompt/messages | Shorthand; wraps to `messages: [{role: "user", content: prompt}]`. |
| `messages` | array  | exactly one of prompt/messages | Full turns, each `{role, content}`.                                |
| `system`   | string | no                             | Runtime system override. Wins over manifest `system`.              |
| `options`  | object | no                             | Per-call option overrides.                                         |

Validation: passing both `prompt` and `messages`, or neither, throws `InvokeError("ERR_INVALID_INPUT", …)`. Each message is checked for `role ∈ {system, user, assistant}` and a string `content`; off-contract values throw the same code.

## Output

```ts
{
  text: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason: "stop" | "length" | "content-filter" | "error" | "other";
}
```

The controller validates the model's return value before forwarding; if a provider deviates, it throws `InvokeError("ERR_CONTRACT_VIOLATION", …)`.

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
      prompt: "Summarize:\n${{ vars.articleText }}"
    invoke:
      kind: Ai.Text
      name: Summarizer
  - name: Save
    inputs:
      summary: "${{ steps.Summarize.result.text }}"
    invoke:
      kind: Sql.Exec
      connection: { kind: Sql.Connection, name: Db }
      inputs:
        sql: "INSERT INTO summaries (text) VALUES (?)"
        bindings: ["${{ inputs.summary }}"]
```

`steps.Summarize.result.{text,usage,finishReason}` is fully typed — the analyzer's `x-telo-step-context` derives it from the abstract's declared outputType.

## What's NOT here

- **Streaming.** `Ai.Text` is buffered; chunked output lives in [Ai.TextStream](./ai-text-stream.md), which shares the same provider resources via `Ai.Model`.
- **Tool use / function calling.** Lives in the future `Ai.Agent` / `Ai.Worker` kinds.
- **Multimodal input.** `content` is a string today. Widening to `string | ContentPart[]` later is non-breaking.
