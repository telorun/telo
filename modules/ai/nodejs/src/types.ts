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
import type { ContentPart, MessageContent } from "./content.js";

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

/** Result of a buffered (non-streaming) completion, as declared by `Ai.Model`'s
 *  `outputType` — the kernel validates it at dispatch, so nothing here is
 *  re-checked by hand.
 *
 *  `content` is the whole answer as parts; `text` is its text parts
 *  concatenated, carried beside them because the overwhelmingly common consumer
 *  wants exactly that and should not have to fold the list. `toolCalls` is
 *  present when the model asked for tools (`finishReason === "tool-calls"`);
 *  `providerState` is opaque and exists to be replayed. */
export interface CompletionResult {
  content: ContentPart[];
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  toolCalls?: ToolCall[];
  providerState?: unknown;
  alternatives?: Record<string, unknown>[];
}

/** Input passed to a model, buffered or streaming — `Ai.Model`'s and
 *  `Ai.ModelStream`'s declared `inputType`.
 *
 *  There is deliberately NO `signal` member. Cancellation rides the
 *  `InvokeContext` the kernel passes as the second argument to a bound entry
 *  point; an AbortSignal is not declarable data, so a manifest-authored provider
 *  could never have received one this way. */
export interface ModelInvokeInput {
  messages: Message[];
  options?: Record<string, unknown>;
  tools?: ToolDefinition[];
  /** Opaque state a previous turn produced, replayed verbatim so reasoning
   *  survives a tool loop. Never inspected here. */
  providerState?: unknown;
  responseFormat?: Record<string, unknown>;
}

/** Tagged part emitted by a streaming invocation — `Ai.StreamPart`.
 *
 *  `finish` is the ONLY terminator. A failure mid-stream REJECTS the iteration
 *  with a structured error rather than yielding one: an error part has to be
 *  remembered by every drainer, and one that forgets truncates silently. A
 *  thrown error also reaches machinery a data part cannot — `catches:`, a
 *  throws union, a `try:` step.
 *
 *  `text-delta.delta`, `tool-call.toolCall` and `finish.usage` are read by name
 *  by consumers outside this repo (an editor rendering a forwarded stream), so
 *  those names are part of the contract, not an implementation detail. */
export type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "content-part"; part: ContentPart }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "provider-state"; providerState: unknown }
  | { type: "finish"; usage: Usage; finishReason: FinishReason };

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
 *  superset: the shared members are reused, and the agent adds `tool-result` for
 *  a tool it executed. This is the element type the streaming `output` carries. */
export type AgentStreamPart =
  | StreamPart
  | { type: "tool-result"; toolResult: ToolResultRecord };

/**
 * An `Ai.Model` implementation, as the kernel binds it.
 *
 * `invoke` is the DECLARED entry point, not a convention: the kernel binds it at
 * its single instance-production site and AJV-checks both directions at
 * dispatch. So a consumer validates nothing by hand, `telo check` sees the
 * shape, and a provider written in any language — or as a manifest — implements
 * a declared contract rather than a TypeScript interface.
 *
 * The second argument is the `InvokeContext` the kernel forwards; cancellation
 * rides it.
 */
export interface AiModelInstance {
  invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<CompletionResult>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
}

/** What a streaming invocation returns: one handle the caller drains. */
export interface ModelStreamResult {
  output: AsyncIterable<StreamPart>;
}

/**
 * An `Ai.ModelStream` implementation.
 *
 * A separate contract from {@link AiModelInstance} rather than a second method
 * on it: a live output is exempt from validation, so folding the two would take
 * the check away from the buffered path — the one most calls use.
 */
export interface AiModelStreamInstance {
  invoke(input: ModelInvokeInput, ctx?: InvokeContext): Promise<ModelStreamResult>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
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
}
