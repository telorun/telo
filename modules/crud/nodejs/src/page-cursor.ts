/** Where a page ended: the sort it was read under, the last row's value of the
 *  sorted property, and that row's id. Stateless — the text is the whole of it. */
export interface PageCursor {
  /** The sorted property, `-` before it for descending. */
  sort: string;
  value: unknown;
  id: string | number;
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify([cursor.sort, cursor.value, cursor.id])).toString("base64url");
}

/** `undefined` for text that is not a cursor {@link encodeCursor} produced. */
export function decodeCursor(text: string): PageCursor | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch (error) {
    // Not JSON is one of the ways a string is not a cursor; any other failure is not ours to judge.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [sort, value, id] = parsed;
  if (typeof sort !== "string" || !(typeof id === "string" || Number.isSafeInteger(id))) return undefined;
  return { sort, value, id };
}
