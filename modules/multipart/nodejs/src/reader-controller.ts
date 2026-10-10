import type { ControllerContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";
import { releaseUnread } from "./input-release.js";
import { boundaryOf } from "./multipart-framing.js";
import { limitInput, readParts, type FramedPart } from "./multipart-reading.js";

interface ReaderInputs {
  input: AsyncIterable<unknown>;
  contentType: string;
  maxPartBytes?: unknown;
  maxParts?: unknown;
  maxTotalBytes?: unknown;
}

interface ReadPart extends Omit<FramedPart, "content"> {
  content: Stream<Uint8Array>;
}

interface ReaderOutputs {
  parts: Stream<ReadPart>;
}

const WHO = "Multipart.Reader";
const DEFAULT_MAX_PARTS = 1000;

/**
 * Reads a multipart payload incrementally: a stream of parts, each with a stream
 * of bytes.
 *
 * The counterpart to `Multipart.Decoder`, which buffers. Buffering is the right
 * default — parts become ordinary values, and a form's fields are small — but a
 * file upload is exactly the case holding a part whole is wrong for.
 *
 * Advancing discards whatever is left of the current part, so a consumer that
 * inspects headers and skips the body is correct by construction (see
 * `readParts`). Memory is bounded by one upstream chunk plus one part's header
 * block, never by a part's size — which is why only the part count has a default
 * limit here, and the two byte limits apply when the caller sets them.
 *
 * A missing boundary rejects the call, releasing the input first. Everything
 * else is found as the streams are drained, and ends the read: the pull in
 * progress fails, so does the parts stream, and the source is released. The
 * parts stream answers for the input from then on: released before its first
 * pull, it still releases the input.
 */
class MultipartReader implements ResourceInstance<ReaderInputs, ReaderOutputs> {
  constructor(private readonly log: Logger) {}

  async invoke(inputs: ReaderInputs): Promise<ReaderOutputs> {
    let boundary: string;
    try {
      boundary = boundaryOf(inputs?.contentType, WHO);
    } catch (err) {
      await releaseUnread(inputs?.input, WHO, this.log);
      throw err;
    }
    const limits = {
      maxPartBytes: limitInput(inputs.maxPartBytes),
      maxParts: limitInput(inputs.maxParts) ?? DEFAULT_MAX_PARTS,
      maxTotalBytes: limitInput(inputs.maxTotalBytes),
    };
    const parts = streamed(readParts(inputs.input, boundary, limits, WHO));
    return {
      parts: new Stream(
        releasingUnpulled(parts, () => releaseUnread(inputs.input, WHO, this.log)),
      ),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* streamed(parts: AsyncIterable<FramedPart>): AsyncIterable<ReadPart> {
  for await (const part of parts) yield { ...part, content: new Stream(part.content) };
}

/**
 * `parts`, with the release an unstarted generator cannot make: returned before
 * its first pull a generator runs none of its body, so the read beneath it —
 * and the input that read holds — would never be reached.
 */
function releasingUnpulled(
  parts: AsyncIterable<ReadPart>,
  releaseInput: () => Promise<void>,
): AsyncIterable<ReadPart> {
  const done: IteratorResult<ReadPart> = { done: true, value: undefined };
  return {
    [Symbol.asyncIterator]() {
      const iterator = parts[Symbol.asyncIterator]();
      let state: "unpulled" | "reading" | "released" = "unpulled";
      return {
        async next() {
          if (state === "released") return done;
          state = "reading";
          return iterator.next();
        },
        async return() {
          if (state === "reading") return (await iterator.return?.()) ?? done;
          if (state === "unpulled") {
            state = "released";
            await releaseInput();
          }
          return done;
        },
      };
    },
  };
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  _resource: Record<string, unknown>,
  ctx: ResourceContext,
): Promise<MultipartReader> {
  return new MultipartReader(ctx.log);
}
