import { ERR_INPUT_INVALID, InvokeError, valueIssue } from "@telorun/sdk";

export const ERR_CONVERSATION_TURN_RUNNING = "ERR_CONVERSATION_TURN_RUNNING";
export const ERR_CONVERSATION_TURN_NOT_FOUND = "ERR_CONVERSATION_TURN_NOT_FOUND";
export const ERR_CONVERSATION_CONFLICT = "ERR_CONVERSATION_CONFLICT";
export const ERR_CONVERSATION_NOT_FOUND = "ERR_CONVERSATION_NOT_FOUND";
export const ERR_IDEMPOTENCY_KEY_CONFLICT = "ERR_IDEMPOTENCY_KEY_CONFLICT";

/** A refused request: one issue per refused member, its pointer relative to the
 *  invocable's own input (a transport adds its own prefix). */
export function inputInvalid(
  message: string,
  issues: Array<{ pointer: string; keyword?: string; params?: Record<string, unknown> }>,
): InvokeError {
  return new InvokeError(ERR_INPUT_INVALID, message, {
    issues: issues.map((i) => valueIssue(i.pointer, i.keyword, i.params)),
  });
}

export function turnRunning(conversation: string, turn: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_TURN_RUNNING,
    `Conversation '${conversation}' is running turn '${turn}'; wait for it to end, or cancel it.`,
    { conversation, turn },
  );
}

export function turnNotFound(turn: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_TURN_NOT_FOUND,
    `No turn '${turn}' is known, or it is past retention; read the conversation's entries instead.`,
    { turn },
  );
}

export function conflictAfterRetries(conversation: string): InvokeError {
  return new InvokeError(
    ERR_CONVERSATION_CONFLICT,
    `Conversation '${conversation}' kept changing while this request was applied; try again.`,
    { conversation },
  );
}

export function idempotencyConflict(detail: string): InvokeError {
  return new InvokeError(ERR_IDEMPOTENCY_KEY_CONFLICT, detail);
}
