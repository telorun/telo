---
description: "Ai.Model abstract: the LLM client provider every backend implements (invoke + stream methods, message/usage shapes, snapshot redaction). Walkthrough for adding a new provider."
sidebar_label: Ai.Model
---

# `Ai.Model` — the provider contract

> Examples below assume this module is imported with an `imports:` entry under alias `Ai`. Kind references (`Ai.Model`, `Ai.Text`, `Ai.TextStream`, …) follow that alias — if you import the module under a different name, substitute your alias accordingly.

`Ai.Model` is a `Telo.Abstract` declared in `@telorun/ai`. Any module can declare a `Telo.Definition` that **`extends: Ai.Model`** and ship as a drop-in provider for both `Ai.Text` (buffered) and `Ai.TextStream` (streaming).

The `@telorun/ai-openai` package is the canonical first-party implementation. This page is the **contract** every implementation must honour.

```yaml
kind: Telo.Abstract
metadata:
  name: Model
capability: Telo.Provider
```

The abstract carries only the config schema each provider extends. The message-in / completion-out contract is owned by the **operations**: `Ai.Text` and `Ai.TextStream` declare their own `inputType` / `outputType` (see `modules/ai/telo.yaml`). The provider's `invoke` / `stream` methods are documented runtime conventions (like `Sql.Connection.execute()`), backed by runtime validation in `Ai.Text`.

---

## Runtime instance contract

A provider's controller must construct an instance exposing **two operations** plus the usual lifecycle hooks. The consumer kind (`Ai.Text` vs `Ai.TextStream`) chooses which operation to call — there is no `stream` flag.

- **`invoke(input) → CompletionResult`** — buffered completion (used by `Ai.Text` and `Ai.Agent`).
- **`stream(input) → sequence of StreamPart`** — chunked completion the consumer iterates until it ends (used by `Ai.TextStream`).
- **`snapshot()`** — resource state for CEL; **must omit secrets** (see below). Optional `init` / `teardown` lifecycle hooks may also be provided.

The shapes below are language-neutral; each language SDK exposes them as that language's native types.

**`Message`** — one conversation turn:

| field | type | notes |
| --- | --- | --- |
| `role` | `system` \| `user` \| `assistant` \| `tool` | `tool` carries a tool-call result back to the model |
| `content` | string \| `ContentPart[]` | a plain string, or content parts for multimodal turns (see below) |
| `toolCalls` | list of `ToolCall` (optional) | present on assistant turns that requested tools |
| `toolCallId` | string (optional) | on `tool` turns — which call this answers |

**`ContentPart`** — a multimodal content element. `content` may be a plain string (the common case) or an array of parts:

- `{ type: "text", text: string }`
- `{ type: "image", data: Uint8Array | string, mediaType: string }` — `data` is raw bytes (runtime, e.g. a tool result) or a base64 string (manifest-authored). The provider normalizes either to its wire shape (OpenAI: a `data:<mediaType>;base64,…` image URL).

Image content is additive: plain-string messages are unchanged, and a provider that can't carry images in a given message position (e.g. OpenAI `tool` messages) reshapes them in translation.

**`ToolCall`** — `{ id: string, name: string, arguments: object }`.
**`ToolDefinition`** — `{ name: string, description?: string, parameters: object }` (JSON Schema for the args).
**`Usage`** — `{ promptTokens, completionTokens, totalTokens }` (non-negative integers).
**`FinishReason`** — one of `stop` | `length` | `content-filter` | `error` | `tool-calls` | `other`.

**`ModelInvokeInput`** — the argument to both operations:

| field | type | notes |
| --- | --- | --- |
| `messages` | list of `Message` | the canonical turns; at least one |
| `options` | object (optional) | merged caller + manifest option bag |
| `tools` | list of `ToolDefinition` (optional) | **additive** — only `Ai.Agent` passes it |
| `signal` | cancellation signal (optional) | the provider **must** forward it to the underlying client so an abandoned request stops early — see [Invoke Cancellation](../../../kernel/docs/invoke-cancellation.md) |

**`CompletionResult`** (buffered output) — `{ text: string, usage: Usage, finishReason: FinishReason, toolCalls?: list of ToolCall }`. `toolCalls` is present when `finishReason` is `tool-calls`.

**`StreamPart`** (one element of the streamed output) — a tagged record, one of:

- `{ type: "text-delta", delta: string }`
- `{ type: "finish", usage: Usage, finishReason: FinishReason }`
- `{ type: "error", error: { message: string, code?: string, data?: any } }` — a JSON-serializable shape (not a native error object) so generic encoders can frame it on the wire without bespoke translation.

---

## `invoke(input)` semantics

- `messages` is the canonical `{role, content}` array. It is at least one element.
- `options` is the merged option bag from the caller. The provider should layer its own hardcoded defaults (typically none — defer to the SDK) **beneath** `options` and per-resource manifest options.
- `tools` is **additive and optional** — only `Ai.Agent` passes it. When tools are advertised and the model requests one, return `finishReason: "tool-calls"` with the requested calls on `toolCalls`; the agent executes them and replays the results. `Ai.Text`/`Ai.TextStream` never pass `tools`, so providers used only there never produce that path.
- Returns `{ text, usage, finishReason, toolCalls? }`. Map vendor-specific finish reasons into the enum; unknown values map to `"other"`.
- `signal`, when present, **must** be forwarded to the underlying client's cancellation mechanism so a cancelled invocation aborts the live request. For `stream`, capture it when the call starts so it rides into the deferred iteration.
- Errors surface as a thrown error — no swallowing, no retry. Vendor messages stay intact.

## `stream(input)` semantics

- Produces an async sequence of `StreamPart`s (each language's idiomatic stream/iterator). The consumer iterates until the stream ends.
- Emit one `text-delta` part per chunk of generated text. Don't batch — let consumers re-batch if they want.
- After the last delta, emit exactly one `finish` part carrying the aggregated `usage` and `finishReason`.
- On error, emit an `error` part **and** terminate the iterator (throwing is also acceptable; consumers handle both).
- Streams are **single-consumer**. If multi-consumer support is ever needed, that's an explicit future feature.

## `snapshot()` and secrets

The kernel calls `snapshot()` on every resource and exposes the result via CEL as `resources.<name>`. Provider snapshots **must omit secrets** (API keys, etc) — return the resource config with the secret-bearing fields stripped. Non-secret config (model id, base URL, options) should remain visible; redaction is targeted, not wholesale. Each language SDK ships a helper for this (the Node SDK exports `redact` from `@telorun/ai/redact`).

---

## How to add a new provider

The full shape is small. Mirror `@telorun/ai-openai`:

### 1. Manifest (`modules/ai-<provider>/telo.yaml`)

```yaml
kind: Telo.Library
metadata:
  name: ai-<provider>
  namespace: std
  version: 1.0.0
imports:
  # Pull in the abstract so `Ai` is an alias for `extends:` below.
  Ai: std/ai@<version>
exports:
  kinds:
    - <Provider>Model
---
kind: Telo.Definition
metadata:
  name: <Provider>Model
capability: Telo.Provider
extends: Ai.Model
controllers:
  - pkg:npm/@telorun/ai-<provider>@1.0.0?local_path=./nodejs#<provider>-model
schema:
  type: object
  properties:
    model: { type: string }
    apiKey: { type: string, x-telo-eval: compile }
    baseUrl: { type: string, x-telo-eval: compile }
    options: { type: object, additionalProperties: true }
  required: [ model, apiKey ]
  additionalProperties: false
```

### 2. Controller

Implement the controller in your target language using that language's Telo SDK. The `controllers:` locator above points at it (the `pkg:npm/...#<provider>-model` example targets a Node.js controller; a Rust controller would use a `pkg:cargo` locator). Whatever the language, the controller must:

- construct a vendor client from the resource config (`model`, `apiKey`, `baseUrl`, …);
- expose **`invoke(input)`** returning a `CompletionResult` — call the vendor's buffered API and map its result to `{ text, usage, finishReason }`;
- expose **`stream(input)`** producing `StreamPart`s — call the vendor's streaming API, emit one `text-delta` per chunk, then a single `finish` part;
- forward `input.signal` to the vendor client's cancellation mechanism;
- implement **`snapshot()`** to return the config with secret fields stripped.

The Node.js reference implementation is [`@telorun/ai-openai`](https://github.com/telorun/telo/tree/main/modules/ai-openai); follow your SDK's controller guide for the exact entrypoint shape (`register` / `create` / `schema` in Node, `#[controller]` in Rust).

### 3. Tests

- **Hermetic snapshot test** — boot with sentinel apiKey, assert `resources.<name>.apiKey` is absent.
- **Live integration tests** — env-gated. Place under `tests/__fixtures__/` so the auto-discovered suite skips them; run manually with `pnpm run telo modules/ai-<provider>/tests/__fixtures__/<provider>-live-text.yaml` when you have credentials.

That's it. The provider integrates with both `Ai.Text` and `Ai.TextStream` with no further changes.
