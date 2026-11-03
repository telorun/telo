import { createHash } from "node:crypto";
import { toPlainJson } from "@telorun/sdk";

/**
 * The envelope a message is stored in, and the encoding of its body.
 *
 * The body is the PLAIN JSON of the message — the form a reader outside Telo
 * reads, every Telo value written as its plain encoding (an instant as RFC 3339
 * text, a duration as `5400s`, bytes as base64url, an int64 and a uint64 as
 * their exact digits) — with object keys sorted at every depth, so one message
 * has one text and "the same message" is a comparison of digests. Reading it
 * back against the queue's `messageType` restores every value exactly.
 */

/** The envelope generation this module writes and reads. A claimed message of
 *  another generation is not delivered: it is dead-lettered as unreadable. */
export const QUEUE_ENVELOPE_GENERATION = 1;

/** The canonical body text of `message`. */
export function encodeMessageBody(message: unknown): string {
  return canonicalJson(toPlainJson(message));
}

/** Lower-case hex SHA-256 of a body: what an addressable store compares. */
export function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Whether two bodies are the same message — their digests are equal. */
export function sameBody(a: { digest: string }, b: { digest: string }): boolean {
  return a.digest === b.digest;
}

/** A body's size as the bound measures it: its UTF-8 bytes. */
export function bodyBytes(body: string): number {
  return Buffer.byteLength(body, "utf8");
}

/**
 * The plain JSON a body holds, an integer beyond the double range read as a
 * `bigint` from its digits, so no int64 or uint64 loses precision before it is
 * read against the message type.
 */
export function parseMessageBody(body: string): unknown {
  return JSON.parse(body, (_key, value, context?: { source?: string }) => {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
    const source = context?.source;
    return source !== undefined && /^-?\d+$/.test(source) ? BigInt(source) : value;
  });
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError(`A message holds a ${typeof value}, which has no JSON form.`);
    }
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
