import { decodeTypedFrame, encodeTypedFrame, InvokeError, TYPED_FRAME_GENERATION } from "@telorun/sdk";
import type { QueueError } from "@telorun/queue";

/**
 * How a recorded failure is kept in a row: the whole `{ code, message, data? }`
 * as one typed frame, so `data` comes back as the value it was — an int64, an
 * instant, bytes — when the dead-letter handler reads it. The frame generation
 * is stored beside it (`error_generation`), so a later runtime reads a frame
 * an earlier one wrote.
 */
export const STORED_ERROR_GENERATION = TYPED_FRAME_GENERATION;

export function encodeStoredError(error: QueueError): string {
  return encodeTypedFrame({
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  });
}

export function decodeStoredError(text: unknown, generation: unknown): QueueError | undefined {
  if (text === null || text === undefined) return undefined;
  if (typeof text !== "string") {
    throw new InvokeError(
      "ERR_QUEUE_STORE_INCONSISTENT",
      `A stored queue error is ${typeof text}, not frame text.`,
    );
  }
  const decoded = decodeTypedFrame(text, Number(generation ?? STORED_ERROR_GENERATION)) as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  if (typeof decoded?.code !== "string" || typeof decoded.message !== "string") {
    throw new InvokeError(
      "ERR_QUEUE_STORE_INCONSISTENT",
      `A stored queue error does not read as { code, message }: ${text}`,
    );
  }
  return {
    code: decoded.code,
    message: decoded.message,
    ...(decoded.data === undefined ? {} : { data: decoded.data }),
  };
}
