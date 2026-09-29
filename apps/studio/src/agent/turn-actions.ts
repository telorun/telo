import { userMessageId } from "./records";
import type { ChatMessage } from "./types";

/**
 * The transcript read as the agent's turns, for the actions that remove or copy
 * them. A turn is its assistant reply's id; a bubble the agent never admitted
 * (`local`) is not a turn of the agent's and is never counted or acted on.
 */

export function turnIds(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === "assistant" && !m.local).map((m) => m.id);
}

/** How many turns a truncation from `turnId` removes: that turn and every later
 *  one. 0 when the turn is not in the transcript. */
export function turnsFrom(messages: ChatMessage[], turnId: string): number {
  const ids = turnIds(messages);
  const at = ids.indexOf(turnId);
  return at === -1 ? 0 : ids.length - at;
}

/** The transcript as it stands once `turnId` and every later turn are gone. */
export function dropTurnsFrom(messages: ChatMessage[], turnId: string): ChatMessage[] {
  const userAt = messages.findIndex((m) => m.id === userMessageId(turnId));
  const replyAt = messages.findIndex((m) => m.id === turnId && m.role === "assistant");
  const at = userAt === -1 ? replyAt : userAt;
  return at === -1 ? messages : messages.slice(0, at);
}

/** The message that started `turnId`, when the transcript holds it. */
export function turnRequest(messages: ChatMessage[], turnId: string): string | null {
  const user = messages.find((m) => m.id === userMessageId(turnId));
  return user?.role === "user" ? user.text : null;
}

