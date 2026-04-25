/**
 * Shared types for the Ai module. The runtime contract every Ai.Model implementation
 * honours is `AiModelInstance` — two methods (`invoke` for buffered output, `stream`
 * for chunked output) plus the usual ResourceInstance hooks.
 *
 * Providers import these types to type their controller returns; callers (currently
 * just Ai.Completion) import them to type the injected `resource.model`.
 */

/** Message roles supported by the core contract. Multimodal / tool roles are out of scope
 *  for v1 — widening the union later (to include `"tool"` etc.) is non-breaking. */
export type Role = "system" | "user" | "assistant";

/** One turn in the conversation. `content` is a string today; widening to a
 *  `string | ContentPart[]` union for multimodal support is non-breaking. */
export interface Message {
  role: Role;
  content: string;
}

/** Token usage counts returned by every invocation. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Normalized completion termination reason. Provider-specific reasons are mapped
 *  into this enum; unknown reasons map to "other". */
export type FinishReason = "stop" | "length" | "content-filter" | "error" | "other";

/** Result of a buffered (non-streaming) completion. */
export interface CompletionResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
}

/** Input passed to both `invoke` and `stream` on an `AiModelInstance`. */
export interface ModelInvokeInput {
  messages: Message[];
  options?: Record<string, unknown>;
}

/** Tagged part emitted by a streaming invocation. Consumers iterate until the stream
 *  ends; a `finish` part (or `error`) signals completion. */
export type StreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "finish"; usage: Usage; finishReason: FinishReason }
  | { type: "error"; error: Error };

/**
 * Runtime contract every Ai.Model implementation exposes.
 *
 * - `invoke` — buffered path used by Ai.Completion.
 * - `stream` — chunked path reserved for the future Ai.Stream consumer; providers
 *   implement it today so Ai.Stream lands as a pure additive change later. Returns
 *   an `AsyncIterable<StreamPart>` — one handle the caller iterates.
 * - `snapshot` — must redact secrets (see `redact.ts`) before returning.
 */
export interface AiModelInstance {
  invoke(input: ModelInvokeInput): Promise<CompletionResult>;
  stream(input: ModelInvokeInput): AsyncIterable<StreamPart>;
  snapshot?(): Record<string, unknown>;
  init?(): Promise<void> | void;
  teardown?(): Promise<void> | void;
}
