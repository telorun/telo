import { toPlainJson } from "@telorun/sdk";
import { isTopic } from "./topic-grammar.js";

/**
 * The wire form of one message: a JSON object `{ "message": …, "topic"?: … }`,
 * keys sorted at every depth, the message as its PLAIN JSON (every Telo value
 * written as its plain encoding). The payload's UTF-8 size is what the
 * channel's `maxBytes` bounds.
 */
export function encodeBroadcastPayload(topic: string | null, message: unknown): string {
  return canonicalJson(topic === null ? { message: toPlainJson(message) } : { message: toPlainJson(message), topic });
}

export function payloadBytes(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}

export type DecodedPayload =
  | { readonly ok: true; readonly topic: string | null; readonly message: unknown }
  | { readonly ok: false; readonly reason: string };

/** The topic and the plain-JSON message a payload holds (an integer beyond the
 *  double range read as a `bigint`), or why it is no payload. */
export function decodeBroadcastPayload(payload: string): DecodedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload, (_key, value, context?: { source?: string }) => {
      if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
      const source = context?.source;
      return source !== undefined && /^-?\d+$/.test(source) ? BigInt(source) : value;
    });
  } catch {
    return { ok: false, reason: "it is not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "it is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  if (!("message" in record)) return { ok: false, reason: "it has no 'message'" };
  const topic = record.topic;
  if (topic !== undefined && !isTopic(topic)) {
    return { ok: false, reason: "its 'topic' is not a valid topic" };
  }
  return { ok: true, topic: topic ?? null, message: record.message };
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
