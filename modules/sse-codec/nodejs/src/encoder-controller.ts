import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface EncoderResource {
  metadata: { name: string; module?: string };
}

interface EncoderInputs {
  input: AsyncIterable<unknown>;
}

interface EncoderOutputs {
  output: Stream<Uint8Array>;
}

/**
 * Server-Sent Events encoder. Each item becomes one frame:
 *   `[id: <id>\n]event: <type>\ndata: <json>\n\n`
 *
 * Item shape: an object whose optional `type` becomes the SSE event (default
 * `message` when absent) and whose optional `id` (string / number) becomes the
 * SSE `id:` line — the reconnection cursor a client echoes as `Last-Event-ID`.
 * All remaining fields become the JSON-encoded data payload. A typeless object
 * (e.g. a `{ id, data }` replay-journal envelope) frames as a `message` event
 * carrying an `id:` line, so a resumable stream needs no bespoke shaping. Bare
 * strings frame as a `message` event whose data is the JSON-encoded string.
 * `data:` lines must not contain literal newlines, so JSON encoding is the safe
 * default; authors who need raw-text-on-wire should use `PlainText.Encoder`.
 *
 * Mid-stream error: if the upstream iterable throws, emit a final
 * `event: error\ndata: {"message":"..."}\n\n` then end.
 */
class SseEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  constructor(private readonly resource: EncoderResource) {}

  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Sse.Encoder "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    return { output: new Stream(encode(input, name)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* encode(input: AsyncIterable<unknown>, name: string): AsyncIterable<Uint8Array> {
  try {
    for await (const item of input) {
      yield Buffer.from(formatFrame(item, name), "utf8");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield Buffer.from(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, "utf8");
  }
}

function formatFrame(item: unknown, name: string): string {
  if (typeof item === "string") {
    return `event: message\ndata: ${JSON.stringify(item)}\n\n`;
  }
  if (!item || typeof item !== "object") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Sse.Encoder "${name}": items must be an object or string; got ${typeof item}.`,
    );
  }
  const { type, id, ...rest } = item as { type?: unknown; id?: unknown; [k: string]: unknown };
  if (type !== undefined && typeof type !== "string") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Sse.Encoder "${name}": 'type' must be a string when present; got ${typeof type}.`,
    );
  }
  // A newline in 'type'/'id' would terminate the SSE field and inject arbitrary
  // frames (the wire uses \n to delimit fields and \n\n to end an event).
  if (typeof type === "string" && /[\r\n]/.test(type)) {
    throw new InvokeError("ERR_INVALID_INPUT", `Sse.Encoder "${name}": 'type' must not contain a newline.`);
  }
  if (typeof id === "string" && /[\r\n]/.test(id)) {
    throw new InvokeError("ERR_INVALID_INPUT", `Sse.Encoder "${name}": 'id' must not contain a newline.`);
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new InvokeError("ERR_INVALID_INPUT", `Sse.Encoder "${name}": 'id' must be a finite number.`);
  }
  const event = typeof type === "string" ? type : "message";
  // Accept bigint too — a CEL integer id can cross the boundary as one, and
  // silently dropping it would break Last-Event-ID resumption without a signal.
  const idLine =
    typeof id === "string" || typeof id === "number" || typeof id === "bigint" ? `id: ${id}\n` : "";
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(rest)}\n\n`;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EncoderResource,
  _ctx: ResourceContext,
): Promise<SseEncoder> {
  return new SseEncoder(resource);
}

