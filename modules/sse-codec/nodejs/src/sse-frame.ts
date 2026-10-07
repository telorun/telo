import { InvokeError, writePlainJson } from "@telorun/sdk";

/**
 * One Server-Sent Events frame for `item`:
 *   `[id: <id>\n]event: <type>\ndata: <json>\n\n`
 *
 * An object's optional `type` is the event name (`message` when absent), its
 * optional `id` the reconnection cursor, and every remaining field the JSON
 * payload, written in its plain encoding. A bare string frames as a `message`
 * event carrying the JSON-encoded string. `owner` names the writer in a refusal.
 */
export function sseFrame(item: unknown, owner: string): string {
  if (typeof item === "string") {
    return `event: message\ndata: ${writePlainJson(item)}\n\n`;
  }
  if (!item || typeof item !== "object") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${owner}: items must be an object or string; got ${typeof item}.`,
    );
  }
  const { type, id, ...rest } = item as { type?: unknown; id?: unknown; [k: string]: unknown };
  if (type !== undefined && typeof type !== "string") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${owner}: 'type' must be a string when present; got ${typeof type}.`,
    );
  }
  // A newline in 'type'/'id' would terminate the SSE field and inject arbitrary
  // frames (the wire uses \n to delimit fields and \n\n to end an event).
  if (typeof type === "string" && /[\r\n]/.test(type)) {
    throw new InvokeError("ERR_INVALID_INPUT", `${owner}: 'type' must not contain a newline.`);
  }
  if (typeof id === "string" && /[\r\n]/.test(id)) {
    throw new InvokeError("ERR_INVALID_INPUT", `${owner}: 'id' must not contain a newline.`);
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new InvokeError("ERR_INVALID_INPUT", `${owner}: 'id' must be a finite number.`);
  }
  const event = typeof type === "string" ? type : "message";
  // Accept bigint too — a CEL integer id can cross the boundary as one, and
  // silently dropping it would break Last-Event-ID resumption without a signal.
  const idLine =
    typeof id === "string" || typeof id === "number" || typeof id === "bigint" ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${writePlainJson(rest)}\n\n`;
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
