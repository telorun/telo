import { InvokeError } from "@telorun/sdk";

export const ERR_CONVERSATION_NOT_FOUND = "ERR_CONVERSATION_NOT_FOUND";
export const ERR_CONVERSATION_ENTRY_NOT_FOUND = "ERR_CONVERSATION_ENTRY_NOT_FOUND";
export const ERR_CONVERSATION_TOOL_CALL_NOT_FOUND = "ERR_CONVERSATION_TOOL_CALL_NOT_FOUND";
export const ERR_CONVERSATION_CONFLICT = "ERR_CONVERSATION_CONFLICT";
export const ERR_CONVERSATION_CURSOR_INVALID = "ERR_CONVERSATION_CURSOR_INVALID";
export const ERR_CONVERSATION_MESSAGE_NOT_STORABLE = "ERR_CONVERSATION_MESSAGE_NOT_STORABLE";
export const ERR_CONVERSATION_UNAVAILABLE = "ERR_CONVERSATION_UNAVAILABLE";
export const ERR_CONVERSATION_ATTACHMENT_NOT_FOUND = "ERR_CONVERSATION_ATTACHMENT_NOT_FOUND";

export function conversationNotFound(id: string): InvokeError {
  return new InvokeError(ERR_CONVERSATION_NOT_FOUND, `No conversation '${id}' exists.`);
}

export function entryNotFound(conversation: string, entry: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_ENTRY_NOT_FOUND,
    `Conversation '${conversation}' has no entry '${entry}'.`,
  );
}

export function toolCallNotFound(entry: string, toolCallId: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_TOOL_CALL_NOT_FOUND,
    `Entry '${entry}' holds no tool call '${toolCallId}'.`,
  );
}

export function conflict(detail: string): InvokeError {
  return new InvokeError(ERR_CONVERSATION_CONFLICT, detail);
}

export function cursorInvalid(): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_CURSOR_INVALID,
    "The cursor was not returned by this listing, or the store can no longer read it. Start again without a cursor.",
  );
}

/** One answer for an attachment that is unknown, released, or not this
 *  conversation's to name, so an id reveals nothing about where it is held. */
export function attachmentNotFound(attachment: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_ATTACHMENT_NOT_FOUND,
    `No attachment '${attachment}' is available here: it is unknown, expired or deleted, or held by another conversation.`,
    { attachment },
  );
}
