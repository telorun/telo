/**
 * Shared types for the Ai module. The runtime contract every Ai.Model implementation
 * honours is `AiModelInstance` — two methods (`invoke` for buffered output, `stream`
 * for chunked output) plus the usual ResourceInstance hooks.
 *
 * Providers import these types to type their controller returns; callers
 * (`Ai.Text` for buffered, `Ai.TextStream` for streaming, `Ai.Agent` for the
 * tool-use loop) import them to type the injected `resource.model`.
 */

import type { InvokeContext } from "@telorun/sdk";
import type { MessageContent } from "./content.js";

export type { ContentPart, ImagePart, MessageContent, TextPart } from "./content.js";

/** Message roles supported by the core contract. `tool` carries a tool-call result
 *  back to the model (paired with `toolCallId`). */
export type Role = "system" | "user" | "assistant" | "tool";

/** A tool call requested by the model (on output) or replayed to it (on an assistant
 *  message). `arguments` is the model-produced argument object, validated against the
 *  tool's advertised `parameters` schema. `id` correlates a `tool`-role result message
 *  (via its `toolCallId`) back to the call that produced it. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One turn in the conversation. `content` is either a plain string or an array of
 *  content parts (text + image) for multimodal turns — see `MessageContent`.
 *
 *  - assistant turns may carry `toolCalls` (the model asked to invoke tools);
 *    `content` may be empty in that case.
 *  - `tool` turns carry `toolCallId` (which call this answers) and put the tool
 *    result in `content` — a string, or content parts when the tool returned an
 *    image (a vision tool result). */
export interface Message {
  role: Role;
  content: MessageContent;
  /** Present on assistant turns that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `tool` turns — the id of the call this message answers. */
  toolCallId?: string;
}

/** A tool advertised to the model: name, optional description, and the JSON Schema
 *  the model must produce arguments against. The model never sees Telo refs — only
 *  this shape. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/** What a run cost, in whatever the provider bills. `unit` is an open vocabulary
 *  (`tokens`, `credits`, `seconds`, `images`) and `total` is the one number a spend
 *  aggregator can sum across providers and modalities; `details` carries the
 *  provider's own breakdown. Omitted entirely when a provider reports nothing —
 *  absent means absent, so no consumer has to special-case a sentinel unit. */
export interface UsageQuantity {
  unit: string;
  total: number;
  details?: Record<string, unknown>;
}

/** Token usage counts returned by every completion.
 *
 *  `unit` / `total` are the provider-neutral half shared with `UsageQuantity`, so
 *  one consumer totals spend across text and image calls. They are stamped by the
 *  consuming kind (Ai.Text / Ai.Agent) from `totalTokens`, not reported by
 *  providers — which is why they are optional on this producer-facing type while
 *  the kinds declare them required on their output. See `usage.ts`. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  unit?: string;
  total?: number;
}

/** Normalized completion termination reason. Provider-specific reasons are mapped
 *  into this enum; unknown reasons map to "other". `tool-calls` means the model
 *  finished a turn by requesting one or more tools. */
export type FinishReason = "stop" | "length" | "content-filter" | "error" | "tool-calls" | "other";

/** Result of a buffered (non-streaming) completion. `toolCalls` is present when the
 *  model requested tools (`finishReason === "tool-calls"`); the consumer (Ai.Agent)
 *  executes them and replays the results. */
export interface CompletionResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  toolCalls?: ToolCall[];
}

/** Input passed to both `invoke` and `stream` on an `AiModelInstance`. `tools`, when
 *  present, advertises the callable tools to the model; only `Ai.Agent` passes it
 *  (`Ai.Text`/`Ai.TextStream` never do). */
export interface ModelInvokeInput {
  messages: Message[];
  options?: Record<string, unknown>;
  tools?: ToolDefinition[];
  /** Cooperative cancellation signal, threaded from the invoke's `InvokeContext`.
   *  Providers forward it to their underlying SDK (`abortSignal`) so an abandoned
   *  request stops its live model connection instead of running to completion. */
  signal?: AbortSignal;
}

/** Tagged part emitted by a streaming invocation. Consumers iterate until the stream
 *  ends; a `finish` part (or `error`) signals completion.
 *
 *  `error` carries a JSON-serializable shape (not a native `Error`) so generic
 *  encoders (`Encode.Ndjson`, `Encode.Sse`) can serialize the part without a
 *  bespoke translation step. Provider controllers translate native Errors to
 *  this shape at yield time. */
export type StreamPartError = { message: string; code?: string; data?: unknown };
export type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: StreamPartError };

/** One tool execution's result, as recorded by the agent. Shared shape between the
 *  buffered agent's `StepTrace.toolResults` and the streaming agent's `tool-result`
 *  event, so a streaming consumer is never a strictly poorer event than the buffered
 *  trace. `content` is `MessageContent` — a string, or content parts when a tool
 *  answers with an image (mirroring the buffered agent). `error` is true when the
 *  dispatch failed and the message fed back to the model is an error string. */
export interface ToolResultRecord {
  toolCallId: string;
  name: string;
  content: MessageContent;
  error?: boolean;
}

/** Tagged part emitted by a streaming *agent* (`Ai.AgentStream`) — the module's
 *  streaming deliverable, distinct from the model-facing `StreamPart`. It is a
 *  superset: the shared members (`text-delta`, `tool-call`, `finish`, `error`) are
 *  reused from `StreamPart`, and the agent adds `tool-result` for a tool it executed.
 *  This is the element type the streaming `output` (`x-telo-stream`) carries. */
export type AgentStreamPart =
  | StreamPart
  | { type: "tool-result"; toolResult: ToolResultRecord };

/**
 * Runtime contract every Ai.Model implementation exposes.
 *
 * - `invoke` — buffered path used by Ai.Text and Ai.Agent.
 * - `stream` — chunked path used by Ai.TextStream. Returns an `AsyncIterable<StreamPart>`
 *   — one handle the caller iterates until the terminator (a `finish` part, an `error`
 *   part, or a thrown error from the iterator itself).
 * - `snapshot` — must redact secrets (see `redact.ts`) before returning.
 */
export interface AiModelInstance {
  invoke(input: ModelInvokeInput): Promise<CompletionResult>;
  stream(input: ModelInvokeInput): AsyncIterable<StreamPart>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

// --- Image generation (Ai.ImageModel / Ai.Image) ---

/** Encoded image bytes plus their MIME type — the currency of the image contract,
 *  on the way in (references, masks) and on the way out. Raw bytes rather than
 *  base64 so a result feeds Fs.FileWrite, Image.Overlay and multimodal message
 *  parts without a conversion step. */
export interface ImageBytes {
  data: Uint8Array;
  mediaType: string;
}

/** One produced image. `width`/`height` are whatever the provider reported — they
 *  are never derived from the bytes, so a consumer needing them guaranteed decodes
 *  the image itself. `details` is the provider's own per-image extras (seed, safety
 *  flags). */
export interface GeneratedImage extends ImageBytes {
  width?: number;
  height?: number;
  details?: Record<string, unknown>;
}

/** Why a generation ended. A refusal carries no bytes, so it is reported once for
 *  the run rather than per image — `content-filter` with a short (or empty)
 *  `images` array is how partial and total refusal are told apart. */
export type ImageFinishReason = "stop" | "content-filter" | "error" | "other";

/** Buffered output of an image generation. Declared in the manifest as the shared
 *  `ImageResult` type and AJV-checked by the kernel at dispatch; this interface is
 *  convenience typing for Node providers, not the contract itself. */
export interface ImageGenerationResult {
  images: GeneratedImage[];
  finishReason: ImageFinishReason;
  usage?: UsageQuantity;
  text?: string;
}

/** Input to an `AiImageModelInstance.invoke`. No `signal` member: cancellation rides
 *  the `InvokeContext` passed as the second argument, the way every bound entry
 *  point receives it — an AbortSignal is not declarable data, and the input is
 *  contract-checked against a manifest schema.
 *
 *  `intent` names what the reference `images` are for. Its vocabulary is each
 *  provider's own (declared as `$defs/Intent` in its schema, which is where
 *  Ai.Image's static check comes from), so the contract types it as a plain
 *  string. */
export interface ImageInvokeInput {
  prompt?: string;
  intent?: string;
  images?: ImageBytes[];
  mask?: ImageBytes;
  options?: Record<string, unknown>;
}

/**
 * Runtime contract every Ai.ImageModel implementation exposes.
 *
 * `invoke` is the kernel's BOUND entry point, not a convention method like
 * `AiModelInstance.invoke` — the kernel binds it at instance creation and validates
 * inputs and outputs against the manifest-declared contract, so an implementation
 * gets enforcement for free and any-language providers have a declared shape to
 * implement.
 *
 * A provider that runs generation as an async job must forward `ctx.cancellation.signal`
 * through its POLL LOOP, not merely the first request — an abandoned invoke must stop
 * polling, not keep billing.
 *
 * `snapshot` must redact secrets (see `redact.ts`).
 */
export interface AiImageModelInstance {
  invoke(input: ImageInvokeInput, ctx?: InvokeContext): Promise<ImageGenerationResult>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

/** A tool the model can call, as surfaced by an Ai.ToolProvider: the advertised
 *  schema plus an opaque-to-the-model name. The agent merges descriptors from every
 *  provider into the `tools` it passes the model. */
export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Runtime contract every Ai.ToolProvider implementation exposes. A tool provider is a
 * `Telo.Mount` mounted into an Ai.Agent: the agent calls `listTools()` to learn what to
 * advertise to the model and `callTool()` to dispatch a model-requested call.
 *
 * `Ai.Tools` (static list, in @telorun/ai) and `AiMcp.ToolProvider` (MCP discovery, in
 * @telorun/ai-mcp) both implement it; the agent never knows which.
 *
 * `callTool` may return a plain value (stringified back to the model), a string, or
 * multimodal content parts (`MessageContent` / `ContentPart[]`) when the tool answers
 * with an image — the agent carries parts through the `tool` message untouched.
 */
export interface AiToolProviderInstance {
  listTools(): Promise<ToolDescriptor[]> | ToolDescriptor[];
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
