import type { Logger } from "@telorun/sdk";
import { InvokeError, integerInput } from "@telorun/sdk";
import { logCompletion } from "./completion-log.js";
import type { StreamPart, Usage } from "./types.js";

/**
 * Usage accounting shared by the completion kinds.
 *
 * `unit` / `total` are the provider-neutral half of a usage report — the same pair
 * `UsageQuantity` carries for image generation — so one consumer can total spend
 * across modalities. They are stamped by the OPERATION rather than asked of every
 * provider: the token triple already carries the answer, and deriving it here keeps
 * existing providers unchanged.
 */

/**
 * A model's usage as plain JS numbers.
 *
 * `Ai.Model` declares its token counts as `integer`, and a declared integer
 * crosses a dispatch boundary as an int64 — that is what the declaration MEANS,
 * and it is why the contract is worth declaring. A consumer that ADDS to one
 * has to convert first: accumulating across an agent's turns is `0 + 1n`, which
 * is a TypeError rather than a sum.
 *
 * Refuses rather than clamping a count it cannot represent. Unreachable for a
 * token count in practice, which is the point: the alternative is a silently
 * wrong total.
 */
export function tokenCounts(usage: Usage): Usage {
  const count = (value: unknown, field: string): number => {
    const n = integerInput(value);
    if (n === undefined) {
      throw new InvokeError(
        "ERR_CONTRACT_VIOLATION",
        `usage.${field} is not a representable integer: ${String(value)}.`,
      );
    }
    return n;
  };
  return {
    ...usage,
    promptTokens: count(usage.promptTokens, "promptTokens"),
    completionTokens: count(usage.completionTokens, "completionTokens"),
    totalTokens: count(usage.totalTokens, "totalTokens"),
    ...(usage.total === undefined ? {} : { total: Number(usage.total) }),
  };
}

/** Stamp the provider-neutral half onto a token triple. Non-destructive: a provider
 *  that already reported `unit`/`total` keeps them. */
export function withTokenQuantity(usage: Usage): Usage {
  if (usage.unit !== undefined && usage.total !== undefined) return usage;
  return { ...usage, unit: usage.unit ?? "tokens", total: usage.total ?? usage.totalTokens };
}

/** Stamp the terminal `finish` part of a provider's stream, so a streamed run
 *  reports usage the same way a buffered one does. Without this the cross-modal
 *  aggregation property would hold only for buffered calls — a distinction no
 *  consumer of a usage figure has any reason to expect. Lazy: every other part
 *  passes straight through, and abandoning the consumer still closes the source.
 *
 *  Deliberately pure — reporting is `reportStreamUsage` below, so this stays a
 *  normalization helper testable without a logger. */
export async function* stampStreamUsage(
  parts: AsyncIterable<StreamPart>,
): AsyncIterable<StreamPart> {
  for await (const part of parts) {
    yield part.type === "finish"
      ? { ...part, usage: withTokenQuantity(tokenCounts(part.usage)) }
      : part;
  }
}

/** Report the usage carried by an already-stamped stream's terminal part. The
 *  logger is required: usage reporting is not an opt-in, and an optional one
 *  would let a future caller produce a stream that silently reports nothing.
 *
 *  A consumer that abandons the stream produces no record — correctly, since no
 *  terminal usage was ever reported to report on. */
export async function* reportStreamUsage(
  parts: AsyncIterable<StreamPart>,
  log: Logger,
): AsyncIterable<StreamPart> {
  for await (const part of parts) {
    if (part.type === "finish") {
      logCompletion(log, "Streamed completion finished", part.usage, part.finishReason);
    }
    yield part;
  }
}
