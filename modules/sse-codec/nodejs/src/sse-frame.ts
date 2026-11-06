import { InvokeError, writePlainJson } from "@telorun/sdk";

/** One Server-Sent Events frame, as `SseCodec.Frame` declares it. */
export interface SseFrame {
  data: unknown;
  event?: string;
  id?: string | number | bigint;
  retry?: number | bigint;
}

const FRAME_MEMBERS = new Set(["data", "event", "id", "retry"]);

/**
 * The wire text of one frame: `[id: <id>\n][event: <event>\n][retry: <ms>\n]data: <json>\n\n`.
 *
 * `data` is written on one line in its plain JSON encoding; `event`, `id` and
 * `retry` each write their line only when present. A value that is not a frame
 * is refused with `ERR_INVALID_INPUT`, naming `owner`.
 */
export function sseFrame(frame: unknown, owner: string): string {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
    throw refusal(owner, `a frame must be an object; got ${describe(frame)}.`);
  }
  const record = frame as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !FRAME_MEMBERS.has(key));
  if (unknown.length > 0) {
    throw refusal(
      owner,
      `a frame holds only data, event, id and retry; got ${unknown.map((k) => `'${k}'`).join(", ")}.`,
    );
  }
  if (record.data === undefined) throw refusal(owner, "a frame must carry 'data'.");
  const { data, event, id, retry } = record;
  let text = "";
  if (id !== undefined) text += `id: ${frameId(id, owner)}\n`;
  if (event !== undefined) text += `event: ${frameEvent(event, owner)}\n`;
  if (retry !== undefined) text += `retry: ${frameRetry(retry, owner)}\n`;
  return `${text}data: ${writePlainJson(data)}\n\n`;
}

// A line break in a field would end it and start another, injecting frames.
function frameEvent(event: unknown, owner: string): string {
  if (typeof event !== "string" || event.length === 0) {
    throw refusal(owner, `'event' must be a non-empty string; got ${describe(event)}.`);
  }
  if (/[\r\n]/.test(event)) throw refusal(owner, "'event' must not contain a line break.");
  return event;
}

function frameId(id: unknown, owner: string): string {
  if (typeof id === "string") {
    if (/[\r\n]/.test(id)) throw refusal(owner, "'id' must not contain a line break.");
    return id;
  }
  if (typeof id === "bigint" || (typeof id === "number" && Number.isSafeInteger(id))) return String(id);
  throw refusal(owner, `'id' must be a string or an integer; got ${describe(id)}.`);
}

function frameRetry(retry: unknown, owner: string): string {
  const whole = typeof retry === "bigint" || (typeof retry === "number" && Number.isSafeInteger(retry));
  if (!whole || (retry as number | bigint) < 0) {
    throw refusal(owner, `'retry' must be an integer of at least 0 milliseconds; got ${describe(retry)}.`);
  }
  return String(retry);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : "a fractional number";
  if (typeof value === "bigint") return String(value);
  return typeof value;
}

function refusal(owner: string, message: string): InvokeError {
  return new InvokeError("ERR_INVALID_INPUT", `${owner}: ${message}`);
}

/**
 * A comment — a line a reader skips and dispatches nothing for, which is what
 * keeps an idle stream's connection open. A line break in `text` would end the
 * comment and start a frame, so it is refused.
 */
export function sseComment(text: string, owner: string): string {
  if (/[\r\n]/.test(text)) {
    throw new InvokeError("ERR_INVALID_INPUT", `${owner}: a comment must not contain a newline.`);
  }
  return `: ${text}\n\n`;
}
