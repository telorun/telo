/**
 * The framing rules all three kinds share.
 *
 * Encoder, Decoder and Reader ship as three separate bundles, so this file is
 * inlined into each — the same way a shared workspace library is. It exists
 * because the alternative was three copies of the byte search, two of the header
 * parser and two of the Content-Disposition reader, and a fix applied to one of
 * them: the Decoder accepted bare-LF framing while the Reader did not, so the two
 * halves of one module disagreed about which payloads were valid.
 */

/** The framing's line break. A payload MUST be written with it; a payload may be
 *  READ with bare LF, because hand-rolled clients emit it and every other server
 *  accepts it. */
export const CRLF = "\r\n";

/** Largest header block accepted for one part. Headers are metadata and small;
 *  without a cap a payload that never contains a blank line is an unbounded
 *  allocation driven by a remote sender. */
export const MAX_HEADER_BYTES = 64 * 1024;

/** Coerce one chunk off a byte source. `who` names the kind so the message points
 *  at the resource the author declared rather than at this file. */
export function asBytes(chunk: unknown, who: string): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error(`${who}: input yielded ${typeof chunk} — expected bytes.`);
}

export function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The `boundary=` parameter of a multipart media type, quoted or bare. */
export function boundaryOf(contentType: unknown, who: string): string {
  if (typeof contentType !== "string" || contentType.length === 0) {
    throw new Error(`${who}: 'contentType' is required — it carries the boundary.`);
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw new Error(
      `${who}: '${contentType}' declares no boundary, and nothing in the payload ` +
        `identifies where parts begin.`,
    );
  }
  return boundary;
}

/**
 * Where a part's header block ends and its content begins.
 *
 * A part is `[headers] CRLF [body]` (RFC 2046 §5.1.1), and the brackets are real:
 * a part carrying only `content` — the encoder's own output for the schema's
 * minimal shape — has NO headers, so the section opens directly with the blank
 * line. Scanning for two consecutive breaks misses that and reports a malformed
 * part for a payload this module produced.
 *
 * Returns `undefined` when no blank line is present at all, which is the genuinely
 * malformed case.
 */
export function findHeaderEnd(
  section: Uint8Array,
): { headerEnd: number; contentStart: number } | undefined {
  const breakAt = lineBreakLength(section, 0);
  if (breakAt > 0) return { headerEnd: 0, contentStart: breakAt };
  for (let i = 0; i < section.length; i++) {
    const first = lineBreakLength(section, i);
    if (first === 0) continue;
    const second = lineBreakLength(section, i + first);
    if (second > 0) return { headerEnd: i, contentStart: i + first + second };
  }
  return undefined;
}

/** 2 for CRLF, 1 for a bare LF, 0 for anything else. */
function lineBreakLength(section: Uint8Array, at: number): number {
  if (section[at] === 0x0d && section[at + 1] === 0x0a) return 2;
  if (section[at] === 0x0a) return 1;
  return 0;
}

/** Drop the line break the framing puts before a delimiter. It belongs to the
 *  framing, not to the part; keeping it appends stray bytes to every part. */
export function trimTrailingBreak(chunk: Uint8Array): Uint8Array {
  let end = chunk.length;
  if (chunk[end - 1] === 0x0a) end -= 1;
  if (chunk[end - 1] === 0x0d) end -= 1;
  return end === chunk.length ? chunk : chunk.subarray(0, end);
}

/** Header lines to a lowercase-keyed map. A line with no colon is skipped rather
 *  than guessed at — a continuation line is not a header of its own. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

/**
 * One parameter off a `Content-Disposition` value.
 *
 * ANCHORED at a parameter boundary, which is the whole point: an unanchored
 * `name=` matches inside `filename=`, so a part carrying a file name and no field
 * name came back with its file name reported as its form field name — a
 * fabricated value rather than an absent one, and `has(part.name)` unconditionally
 * true.
 */
export function dispositionParam(source: string, key: string): string | undefined {
  const match = new RegExp(
    `(?:^|;)\\s*${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;]*))`,
    "i",
  ).exec(source);
  const quoted = match?.[1];
  if (quoted !== undefined) return quoted.replace(/\\(.)/g, "$1");
  // Only an unquoted token is trimmed: a quoted value's spaces are significant,
  // and a file name is exactly where they occur.
  return match?.[2]?.trim();
}

/** The `name` / `filename` fields a part's Content-Disposition carries, ready to
 *  spread onto a decoded part. Absent stays absent — an empty string would make a
 *  `has()` check answer yes for a part that declared nothing. */
export function dispositionFields(headers: Record<string, string>): {
  name?: string;
  filename?: string;
} {
  const disposition = headers["content-disposition"] ?? "";
  const name = dispositionParam(disposition, "name");
  const filename = dispositionParam(disposition, "filename");
  return {
    ...(name !== undefined ? { name } : {}),
    ...(filename !== undefined ? { filename } : {}),
  };
}
