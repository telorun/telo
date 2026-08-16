import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";
import { asBytes, CRLF, indexOf } from "./multipart-framing.js";

interface EncoderPart {
  content: unknown;
  contentType?: string;
  name?: string;
  filename?: string;
  headers?: Record<string, string>;
}

interface EncoderInputs {
  parts: EncoderPart[];
  subtype?: string;
  boundary?: string;
}

interface EncoderOutputs {
  output: Stream<Uint8Array>;
  contentType: string;
  boundary: string;
}

const WHO = "Multipart.Encoder";

/**
 * Combines parts into one multipart payload.
 *
 * THE BOUNDARY IS GENERATED HERE and returned beside the bytes, because it has to
 * appear in both the framing and the Content-Type header. A caller writing its own
 * header could not know it, and a server given a header whose boundary does not
 * match the body finds no parts at all — a silent empty upload rather than an
 * error. Returning the pair together is what makes them impossible to separate.
 *
 * STREAMING END TO END: parts are written as they are consumed, so a byte-stream
 * part passes through without being buffered. That is the whole reason to
 * assemble the body here rather than in CEL, where concatenation is text-only and
 * whole-payload.
 */
class MultipartEncoder implements ResourceInstance<EncoderInputs, EncoderOutputs> {
  async invoke(inputs: EncoderInputs): Promise<EncoderOutputs> {
    const parts = inputs?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error(`${WHO}: 'parts' must be a non-empty list.`);
    }
    const subtype = inputs.subtype ?? "form-data";
    const boundary = inputs.boundary ?? generateBoundary();
    // A boundary appearing inside a part would terminate it early, splitting one
    // part into two and corrupting the payload with no error anywhere. Checked
    // for every part already IN MEMORY, text and bytes alike — a byte part is as
    // capable of containing the boundary as a text one, and is the likelier
    // carrier since its content is arbitrary. A stream would have to be buffered
    // to check, which is what streaming exists to avoid, so a supplied boundary
    // remains the caller's responsibility as the schema says.
    for (const part of parts) {
      if (containsBoundary(part?.content, boundary)) {
        throw new Error(
          `${WHO}: the boundary '${boundary}' occurs inside a part, which would terminate it ` +
            `early. Omit 'boundary' to have one generated.`,
        );
      }
    }
    return {
      output: new Stream(frame(parts, boundary)),
      contentType: `multipart/${subtype}; boundary=${boundary}`,
      boundary,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function containsBoundary(content: unknown, boundary: string): boolean {
  if (typeof content === "string") return content.includes(boundary);
  if (content instanceof Uint8Array) {
    return indexOf(content, new TextEncoder().encode(boundary), 0) >= 0;
  }
  return false;
}

/** Long and random enough that no realistic payload contains it. The `----` prefix
 *  is the convention every HTTP client uses, and some servers pattern-match it.
 *
 *  NOT a security boundary: `Math.random()` is not a CSPRNG, and this value only
 *  has to be absent from the payload, not unguessable. The schema's `boundary`
 *  field mentions a signed request — what is signed there is the body, and a
 *  caller who needs the boundary itself to be unpredictable supplies its own. */
function generateBoundary(): string {
  let out = "";
  for (let i = 0; i < 24; i++) out += Math.floor(Math.random() * 36).toString(36);
  return `----TeloBoundary${out}`;
}

async function* frame(parts: EncoderPart[], boundary: string): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) {
    yield encoder.encode(`--${boundary}${CRLF}${headerBlock(part)}${CRLF}`);
    yield* contentOf(part.content);
    yield encoder.encode(CRLF);
  }
  // The closing delimiter is what tells a parser the payload ended rather than
  // being truncated; without it a server waits for a part that never arrives.
  yield encoder.encode(`--${boundary}--${CRLF}`);
}

/** Headers derived from the declared fields, then the author's own merged over
 *  them — an explicit header is the most specific statement of intent, so it wins
 *  over one this derived. */
function headerBlock(part: EncoderPart): string {
  const headers: Record<string, string> = {};
  const disposition = dispositionOf(part);
  if (disposition) headers["Content-Disposition"] = disposition;
  if (part.contentType) headers["Content-Type"] = part.contentType;
  for (const [key, value] of Object.entries(part.headers ?? {})) headers[key] = value;
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}${CRLF}`)
    .join("");
}

/** `form-data` when the part is named, which is what a form server keys on. A
 *  `related` part is positional and carries none, so an unnamed part gets no
 *  disposition rather than an empty one. */
function dispositionOf(part: EncoderPart): string | undefined {
  if (part.name === undefined && part.filename === undefined) return undefined;
  const fields = [`form-data`];
  if (part.name !== undefined) fields.push(`name="${escapeQuoted(part.name)}"`);
  if (part.filename !== undefined) fields.push(`filename="${escapeQuoted(part.filename)}"`);
  return fields.join("; ");
}

/** RFC 2616 quoted-string escaping. A filename containing a quote would otherwise
 *  end the parameter early and the server would read a truncated name. */
function escapeQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function* contentOf(content: unknown): AsyncIterable<Uint8Array> {
  if (typeof content === "string") {
    yield new TextEncoder().encode(content);
    return;
  }
  if (content instanceof Uint8Array) {
    yield content;
    return;
  }
  if (isAsyncIterable(content)) {
    for await (const chunk of content) yield asBytes(chunk, WHO);
    return;
  }
  throw new Error(
    `${WHO}: a part's 'content' must be a string, bytes or a byte stream (got ${typeof content}).`,
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value != null && typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: Record<string, unknown>,
  _ctx: ResourceContext,
): Promise<MultipartEncoder> {
  return new MultipartEncoder();
}
