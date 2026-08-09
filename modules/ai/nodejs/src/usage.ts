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
 *  passes straight through, and abandoning the consumer still closes the source. */
export async function* stampStreamUsage(
  parts: AsyncIterable<StreamPart>,
): AsyncIterable<StreamPart> {
  for await (const part of parts) {
    yield part.type === "finish" ? { ...part, usage: withTokenQuantity(part.usage) } : part;
  }
}
