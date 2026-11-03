import type { MessageState } from "./queue-store-contract.js";

const CURSOR_VERSION = 1;

/**
 * The public cursor of a listing: an envelope this module owns around the tail
 * a store returned, bound to the state it lists. A store owns only the tail —
 * text it alone reads — so its format can change with no change to the cursor.
 * A cursor is a position, never a credential: a store re-checks a tail on every
 * call and answers one it cannot read as its own with `cursorInvalid`.
 */
export function encodeListCursor(state: MessageState, tail: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, s: state, t: tail }), "utf8").toString(
    "base64url",
  );
}

/** The tail inside a cursor, or undefined when the cursor is not one this
 *  module wrote for a listing of `state`. */
export function listCursorTail(cursor: string, state: MessageState): string | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof envelope !== "object" || envelope === null) return undefined;
  const { v, s, t } = envelope as Record<string, unknown>;
  return v === CURSOR_VERSION && s === state && typeof t === "string" ? t : undefined;
}
