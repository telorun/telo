import { isTextPart, type ContentPart, type MessageContent } from "./content.js";

/**
 * The `maxToolResultBytes` bound on what a tool result feeds the model. Only text
 * is measured, in UTF-8 bytes: a string keeps its longest whole-code-point prefix
 * within the limit; a part list counts its text parts in order, cuts the one the
 * limit falls in and drops every later text part, while any other part keeps its
 * place uncounted. A cut result ends with a marker naming what was cut.
 */

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The longest prefix of `text` whose UTF-8 encoding fits in `bytes`, never
 *  splitting a code point (`encodeInto` writes whole characters only). */
function prefixWithin(text: string, bytes: number): string {
  const { read } = encoder.encodeInto(text, new Uint8Array(bytes));
  return text.slice(0, read);
}

export function truncationMarker(omitted: number, total: number, limit: number): string {
  return `[truncated: ${omitted} of ${total} bytes cut; a tool result passes at most ${limit} bytes to the model]`;
}

/** The configured limit as a number (a CEL-computed one arrives as an int64);
 *  `undefined` means unbounded. */
export function toolResultByteLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const limit = typeof value === "bigint" ? Number(value) : value;
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) return limit;
  throw new Error(`${label}: 'maxToolResultBytes' must be an integer of at least 1, got ${String(value)}.`);
}

/** Bound `content` to `limit` bytes of text. Content within the limit is returned
 *  as the same value. */
export function boundToolContent(content: MessageContent, limit: number | undefined): MessageContent {
  if (limit === undefined) return content;
  if (typeof content === "string") {
    const total = byteLength(content);
    if (total <= limit) return content;
    const kept = prefixWithin(content, limit);
    return `${kept}\n${truncationMarker(total - byteLength(kept), total, limit)}`;
  }

  let total = 0;
  for (const part of content) if (isTextPart(part)) total += byteLength(part.text);
  if (total <= limit) return content;

  const bounded: ContentPart[] = [];
  let remaining = limit;
  let kept = 0;
  let cut = false;
  for (const part of content) {
    if (!isTextPart(part)) {
      bounded.push(part);
      continue;
    }
    if (cut) continue;
    const size = byteLength(part.text);
    if (size <= remaining) {
      bounded.push(part);
      remaining -= size;
      kept += size;
      continue;
    }
    cut = true;
    const text = prefixWithin(part.text, remaining);
    if (text.length > 0) {
      bounded.push({ type: "text", text });
      kept += byteLength(text);
    }
  }
  bounded.push({ type: "text", text: truncationMarker(total - kept, total, limit) });
  return bounded;
}
