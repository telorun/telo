import type { ControllerContext, Logger, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { Stream } from "@telorun/sdk";
import { releaseUnread } from "./input-release.js";
import { partMissing } from "./multipart-errors.js";
import { boundaryOf } from "./multipart-framing.js";
import { limitInput, readParts, type FramedPart } from "./multipart-reading.js";

interface ReadPartInputs {
  input: AsyncIterable<unknown>;
  contentType: string;
  name: string;
  maxPartBytes?: unknown;
  maxParts?: unknown;
  maxTotalBytes?: unknown;
}

interface ReadPartOutputs extends Omit<FramedPart, "content"> {
  content: Stream<Uint8Array>;
}

const WHO = "Multipart.ReadPart";
const DEFAULT_MAX_PARTS = 1000;

/**
 * The first part named `name`, as soon as its headers are read.
 *
 * The parts before it are discarded as the read passes them, and still count
 * toward the limits; the parts after it are never read. Its `content` answers
 * for the whole input: read to its end, stopped early or released unread, it
 * ends the read and releases the input, and it pulls the source only as its own
 * consumer pulls.
 */
class MultipartReadPart implements ResourceInstance<ReadPartInputs, ReadPartOutputs> {
  constructor(private readonly log: Logger) {}

  async invoke(inputs: ReadPartInputs): Promise<ReadPartOutputs> {
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
    const parts = readParts(inputs.input, boundary, limits, WHO)[Symbol.asyncIterator]();
    // A failure before the match rejects this call; `readParts` has already
    // released the input by then.
    while (true) {
      const next = await parts.next();
      if (next.done) throw partMissing(WHO, inputs.name);
      if (next.value.name !== inputs.name) continue;
      const { content, ...part } = next.value;
      return { ...part, content: new Stream(endingRead(content, () => parts.return?.())) };
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/**
 * `content`, finishing the read when it ends however it ends. Finishing the
 * suspended `readParts` runs its release, and never reads on to the next part.
 */
function endingRead(
  content: AsyncIterable<Uint8Array>,
  finish: () => Promise<unknown> | undefined,
): AsyncIterable<Uint8Array> {
  const done: IteratorResult<Uint8Array> = { done: true, value: undefined };
  return {
    [Symbol.asyncIterator]() {
      const iterator = content[Symbol.asyncIterator]();
      let finished = false;
      const end = async () => {
        if (finished) return;
        finished = true;
        await finish();
      };
      return {
        async next() {
          if (finished) return done;
          let result: IteratorResult<Uint8Array>;
          try {
            result = await iterator.next();
          } catch (err) {
            await end();
            throw err;
          }
          if (result.done) await end();
          return result;
        },
        async return() {
          await end();
          return done;
        },
      };
    },
  };
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: Record<string, unknown>,
  ctx: ResourceContext,
): Promise<MultipartReadPart> {
  return new MultipartReadPart(ctx.log);
}
