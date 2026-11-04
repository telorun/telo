import { cursorInvalid } from "@telorun/ai-conversation";

/** A cursor is a position, never a credential: base64url JSON this module reads back and re-checks on use. */
export function encodeCursor(kind: "list" | "entries", position: unknown[]): string {
  return Buffer.from(JSON.stringify({ v: 1, k: kind, p: position }), "utf8").toString("base64url");
}

export function decodeCursor(kind: "list" | "entries", cursor: string): unknown[] {
  let envelope: unknown;
  try {
    envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw cursorInvalid();
  }
  const { v, k, p } = (envelope ?? {}) as Record<string, unknown>;
  if (v !== 1 || k !== kind || !Array.isArray(p)) throw cursorInvalid();
  return p;
}
