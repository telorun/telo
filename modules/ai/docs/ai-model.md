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

A provider's controller `create()` must return an object exposing **two methods** plus the usual `ResourceInstance` hooks. The consumer kind (`Ai.Text` vs `Ai.TextStream`) chooses which method to call — there is no `stream: boolean` flag.

```ts
// `tool` carries a tool-call result back to the model (paired with toolCallId).
type Role = "system" | "user" | "assistant" | "tool";

interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

interface Message {
  role: Role;
  content: string;
  toolCalls?: ToolCall[];   // assistant turns that requested tools
  toolCallId?: string;      // `tool` turns — which call this answers
}

interface ToolDefinition { name: string; description?: string; parameters: Record<string, unknown> }
interface Usage { promptTokens: number; completionTokens: number; totalTokens: number }
type FinishReason = "stop" | "length" | "content-filter" | "error" | "tool-calls" | "other";

interface CompletionResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  toolCalls?: ToolCall[];   // present when finishReason === "tool-calls"
}

// `tools` is additive — only Ai.Agent passes it; Ai.Text / Ai.TextStream never do.
interface ModelInvokeInput {
  messages: Message[];
  options?: Record<string, unknown>;
  tools?: ToolDefinition[];
}

// error carries a JSON-serializable shape (not a native Error) so generic
// encoders can frame it on the wire without bespoke translation.
type StreamPartError = { message: string; code?: string; data?: unknown };
type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: StreamPartError };

interface AiModelInstance {
  invoke(input: ModelInvokeInput): Promise<CompletionResult>;
  stream(input: ModelInvokeInput): AsyncIterable<StreamPart>;

  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
```

Import the types directly:

```ts
import type {
  AiModelInstance, Message, ToolCall, ToolDefinition,
  ModelInvokeInput, CompletionResult, StreamPart, StreamPartError, Usage, FinishReason,
} from "@telorun/ai/types";
```

---

## `invoke(input)` semantics

- `messages` is the canonical `{role, content}` array. It is at least one element.
- `options` is the merged option bag from the caller. The provider should layer its own hardcoded defaults (typically none — defer to the SDK) **beneath** `options` and per-resource manifest options.
- `tools` is **additive and optional** — only `Ai.Agent` passes it. When tools are advertised and the model requests one, return `finishReason: "tool-calls"` with the requested calls on `toolCalls`; the agent executes them and replays the results. `Ai.Text`/`Ai.TextStream` never pass `tools`, so providers used only there never produce that path.
- Returns `{ text, usage, finishReason, toolCalls? }`. Map vendor-specific finish reasons into the enum; unknown values map to `"other"`.
- Errors surface as thrown `Error` (or `InvokeError`) — no swallowing, no retry. Vendor messages stay intact.

## `stream(input)` semantics

- Returns an `AsyncIterable<StreamPart>`. The consumer iterates until the stream ends.
- Emit one `text-delta` part per chunk of generated text. Don't batch — let consumers re-batch if they want.
- After the last delta, emit exactly one `finish` part carrying the aggregated `usage` and `finishReason`.
- On error, emit an `error` part **and** terminate the iterator (throwing is also acceptable; consumers handle both).
- Streams are **single-consumer**. If multi-consumer support is ever needed, that's an explicit future feature.

## `snapshot()` and secrets

The kernel calls `snapshot()` on every resource and exposes the result via CEL as `resources.<name>`. Provider snapshots **must omit secrets** (API keys, etc). Use the shared helper:

```ts
import { redact } from "@telorun/ai/redact";

snapshot() {
  return redact(["apiKey"], this.resource);
}
```

Non-secret config (model id, base URL, options) should remain visible — `redact()` is targeted, not wholesale.

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
  Ai: std/ai@0.4.0
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

### 2. Controller (`nodejs/src/<provider>-model-controller.ts`)

```ts
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { redact } from "@telorun/ai/redact";
import type { AiModelInstance, CompletionResult, FinishReason, ModelInvokeInput, StreamPart, Usage } from "@telorun/ai/types";

class <Provider>ModelInstance implements ResourceInstance, AiModelInstance {
  // ...construct vendor SDK client from resource.apiKey / baseUrl

  async invoke({ messages, options }: ModelInvokeInput): Promise<CompletionResult> {
    // call the SDK's buffered API; map result to { text, usage, finishReason }
  }

  async *stream({ messages, options }: ModelInvokeInput): AsyncIterable<StreamPart> {
    // call the SDK's streaming API; yield text-delta parts then a finish part
  }

  snapshot() { return redact(["apiKey"], this.resource); }
}

export function register(_ctx: ControllerContext): void {}
export async function create(resource: any, _ctx: ResourceContext) {
  return new <Provider>ModelInstance(resource);
}
export const schema = { type: "object", additionalProperties: true };
```

### 3. Tests

- **Hermetic snapshot test** — boot with sentinel apiKey, assert `resources.<name>.apiKey` is absent.
- **Live integration tests** — env-gated. Place under `tests/__fixtures__/` so the auto-discovered suite skips them; run manually with `pnpm run telo modules/ai-<provider>/tests/__fixtures__/<provider>-live-text.yaml` when you have credentials.

That's it. The provider integrates with both `Ai.Text` and `Ai.TextStream` with no further changes.
