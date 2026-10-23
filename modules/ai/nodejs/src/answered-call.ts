import { modelRequestRejected } from "./model-failure.js";
import type { Message } from "./types.js";

/**
 * The call a tool message answers, which every provider keys the result on. A
 * tool message naming none is refused while the request is built, as
 * `ERR_MODEL_REQUEST_REJECTED` naming its index: sent with an empty id, an
 * endpoint rejects the whole request, naming no message.
 */
export function answeredCallId(message: Message, index: number, label: string): string {
  if (typeof message.toolCallId === "string" && message.toolCallId !== "") return message.toolCallId;
  throw modelRequestRejected(
    `${label}: messages[${index}] is a tool message with no 'toolCallId', so it answers no call. A tool message names the id of the call it is the result of.`,
  );
}
