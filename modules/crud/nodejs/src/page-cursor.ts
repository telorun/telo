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

/** The JSON a cursor's text holds; `undefined` for text that holds none. */
function parseCursorText(text: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch (error) {
    // Not JSON is one of the ways a string is not a cursor; any other failure is not ours to judge.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** `undefined` for text that is not a cursor {@link encodeCursor} produced. */
export function decodeCursor(text: string): PageCursor | undefined {
  const parsed = parseCursorText(text);
  if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
  const [sort, value, id] = parsed;
  if (typeof sort !== "string" || !(typeof id === "string" || Number.isSafeInteger(id))) return undefined;
  return { sort, value, id };
}

/** Where a facet page ended: the faceted property and the last value answered. */
export interface FacetCursor {
  property: string;
  value: unknown;
}

const FACET_MARK = "facet";

export function encodeFacetCursor(cursor: FacetCursor): string {
  return Buffer.from(JSON.stringify([FACET_MARK, cursor.property, cursor.value])).toString("base64url");
}

/** `undefined` for text that is not a cursor {@link encodeFacetCursor} produced. */
export function decodeFacetCursor(text: string): FacetCursor | undefined {
  const parsed = parseCursorText(text);
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== FACET_MARK || typeof parsed[1] !== "string") {
    return undefined;
  }
  return { property: parsed[1], value: parsed[2] };
}
