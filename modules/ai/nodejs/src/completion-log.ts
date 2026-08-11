import { type Logger } from "@telorun/sdk";
import type { FinishReason, Usage } from "./types.js";

/**
 * The one record every completion kind emits when a model call finishes.
 *
 * `info`, not `debug`: token usage is the metered quantity — what a run costs and
 * why a bill moved — and it is reported nowhere else by default. Tracing carries
 * the call's shape but is off unless asked for, and the returned `usage` object
 * is only as visible as whatever the caller does with it.
 *
 * Emitted by the OPERATION rather than by each provider, which is the same grain
 * the module already normalizes usage on (see `withTokenQuantity`): a provider
 * published by someone else reports identically without doing anything.
 *
 * Prompts, messages and completions are never attributes. They are the user's
 * content, frequently the most sensitive thing in the process, and no threshold
 * is the right place to decide to spill them into a log.
 */
export function logCompletion(
  log: Logger,
  message: string,
  usage: Usage,
  finishReason: FinishReason | undefined,
  extra?: Record<string, number>,
): void {
  log.info(message, {
    "gen_ai.usage.input_tokens": usage.promptTokens,
    "gen_ai.usage.output_tokens": usage.completionTokens,
    // An array because the convention is plural — a provider may report more than
    // one, and a homogeneous array is what §6.1 requires for OTLP export.
    "gen_ai.response.finish_reasons": finishReason ? [finishReason] : [],
    ...extra,
  });
}
