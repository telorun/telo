import { InvokeError, type CelDuration, type CelTimestamp, type TraceCarrier } from "@telorun/sdk";
import { storeInconsistent } from "./queue-operation.js";
import { bodyBytes, bodyDigest, encodeMessageBody, QUEUE_ENVELOPE_GENERATION } from "./message-envelope.js";
import { mintMessageId } from "./message-id.js";
import type { EnqueueOutcome, EnqueueRequest, QueueSettings } from "./queue-store-contract.js";

export const ERR_QUEUE_MESSAGE_TOO_LARGE = "ERR_QUEUE_MESSAGE_TOO_LARGE";
export const ERR_QUEUE_ID_CONFLICT = "ERR_QUEUE_ID_CONFLICT";

/** One message as a caller hands it over (`Queue.EnqueueItem`). */
export interface EnqueueItem {
  message: unknown;
  id?: string;
  after?: CelDuration | CelTimestamp;
}

/**
 * The request a store is handed for one item: the id given or minted, the
 * canonical body and its digest, the envelope generation and the caller's
 * trace. A body over the queue's bound is refused here, before the store is
 * called. `index` is the item's place in a batch, carried into the refusal.
 */
export function enqueueRequestOf(
  describe: string,
  item: EnqueueItem,
  settings: QueueSettings,
  carrier: TraceCarrier | undefined,
  index?: number,
): EnqueueRequest {
  const body = encodeMessageBody(item.message);
  const bytes = bodyBytes(body);
  if (bytes > settings.maxMessageBytes) {
    const at = index === undefined ? "the message" : `message ${index}`;
    throw new InvokeError(
      ERR_QUEUE_MESSAGE_TOO_LARGE,
      `${describe}: ${at} encodes to ${bytes} bytes, over the queue's maxMessageBytes of ` +
        `${settings.maxMessageBytes}; nothing was stored.`,
      { ...(index === undefined ? {} : { index }), bytes, maxBytes: settings.maxMessageBytes },
    );
  }
  return {
    id: item.id ?? mintMessageId(),
    body,
    digest: bodyDigest(body),
    generation: QUEUE_ENVELOPE_GENERATION,
    ...(item.after === undefined ? {} : { after: item.after }),
    ...(carrier ? { traceparent: carrier.traceparent } : {}),
    ...(carrier?.tracestate === undefined ? {} : { tracestate: carrier.tracestate }),
  };
}

/** Whether an item was stored; a conflict is refused with its id. */
export function enqueuedOf(
  describe: string,
  id: string,
  outcome: EnqueueOutcome | undefined,
  index?: number,
): boolean {
  if (outcome?.status === "stored") return true;
  if (outcome?.status === "duplicate") return false;
  if (outcome?.status === "conflict") {
    throw new InvokeError(
      ERR_QUEUE_ID_CONFLICT,
      `${describe}: the queue already holds a different message under the id '${id}'; nothing ` +
        `was stored for it.`,
      { ...(index === undefined ? {} : { index }), id },
    );
  }
  throw storeInconsistent(describe, `${JSON.stringify(outcome)} for the enqueue of '${id}'`);
}
