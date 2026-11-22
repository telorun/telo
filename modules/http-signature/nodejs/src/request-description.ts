/** What a transport hands over: a plain description of one request. */
export interface RequestDescription {
  method: string;
  /** The absolute target URI, the query exactly as received. */
  targetUri: string;
  headers: Record<string, string | string[] | undefined>;
  /** The request's body bytes; absent and `null` read as the empty body. */
  body?: Uint8Array | null;
}

/** A header's value as the signature grammars read it: one line, repeated fields joined with ", ". */
export function headerValue(headers: RequestDescription["headers"], name: string): string | undefined {
  const wanted = name.toLowerCase();
  let found: string | string[] | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== undefined) {
      found = found === undefined ? value : [...[found].flat(), ...[value].flat()];
    }
  }
  if (found === undefined) return undefined;
  return [found]
    .flat()
    .map((value) => value.replace(/\r?\n[ \t]+/g, " ").trim())
    .join(", ");
}
