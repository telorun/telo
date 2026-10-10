import {
  ERR_INPUT_INVALID,
  InvokeError,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { createHash } from "node:crypto";
import { HeldSource } from "./held-source.js";
import { BoundOperation, boundInput, type OperationResource } from "./operation-binding.js";

interface PutInputs {
  key: string;
  content: unknown;
  contentType: string;
  maxBytes?: unknown;
}

interface PutOutputs {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** What the measured source learned while the store drained it. */
interface Measure {
  size: number;
  readonly hash: ReturnType<typeof createHash>;
}

/**
 * Blob.Put — store bytes or a byte stream under a key, replacing atomically.
 *
 * The bound, the count, the digest and the chunk check are made here, once for
 * every store: the store is handed a measured source, and a refusal reaches it
 * as an ordinary failure of that source, after which it stores nothing.
 *
 * The source is this operation's to release, never the store's: on any exit
 * where it has not ended — the store failing before its first pull or after it,
 * a refusal — it is released here, once.
 */
class BlobPut implements ResourceInstance<PutInputs, PutOutputs> {
  constructor(private readonly bound: BoundOperation) {}

  async invoke(inputs: PutInputs, ctx?: InvokeContext): Promise<PutOutputs> {
    const { key, contentType } = inputs;
    const maxBytes = boundInput(inputs.maxBytes);
    const source = this.sourceOf(inputs.content);
    // Bytes held whole are refused up front, with the store never called.
    if (inputs.content instanceof Uint8Array && maxBytes !== undefined) {
      if (inputs.content.byteLength > maxBytes) throw this.tooLarge(key, maxBytes);
    }
    const measure: Measure = { size: 0, hash: createHash("sha256") };
    const held = new HeldSource(source);
    try {
      const measured = this.measured(held, key, maxBytes, measure);
      await this.bound.store.put(key, measured, { contentType }, ctx);
    } finally {
      await this.release(held, key);
    }
    return { key, size: measure.size, sha256: measure.hash.digest("hex"), contentType };
  }

  /** Runs while a failure may be on its way out, so a release that fails is
   *  reported in the log rather than raised over it. */
  private async release(held: HeldSource, key: string): Promise<void> {
    try {
      await held.release();
    } catch (err) {
      this.bound.log.warn("Source not released", { "blob.key": key }, { error: err });
    }
  }

  private sourceOf(content: unknown): AsyncIterable<unknown> {
    if (content instanceof Uint8Array) return once(content);
    if (isAsyncIterable(content)) return content;
    // A stream is a live value the input contract never inspects, so with a
    // stream branch declared the contract admits any value here; the refusal
    // it would have made is made here, under its code.
    throw this.invalidContent("must be bytes or a stream of bytes");
  }

  /** What the store drains. Its `return()` changes nothing: a store may call
   *  it at any time, and the source stays this operation's to release. */
  private measured(
    held: HeldSource,
    key: string,
    maxBytes: number | undefined,
    measure: Measure,
  ): AsyncIterable<Uint8Array> {
    const done: IteratorResult<Uint8Array> = { done: true, value: undefined };
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        const pulled = await held.next();
        if (pulled.done) return done;
        const chunk = this.byteChunk(pulled.value);
        if (maxBytes !== undefined && measure.size + chunk.byteLength > maxBytes) {
          throw this.tooLarge(key, maxBytes);
        }
        measure.size += chunk.byteLength;
        measure.hash.update(chunk);
        return { done: false, value: chunk };
      },
      return: async () => done,
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  private byteChunk(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw this.invalidContent(
      `is a stream that yielded ${value === null ? "null" : typeof value} — expected bytes`,
    );
  }

  private invalidContent(problem: string): InvokeError {
    const message = `${this.bound.describe}: 'content' ${problem}.`;
    return new InvokeError(ERR_INPUT_INVALID, message, {
      issues: [{ path: "content", message }],
    });
  }

  private tooLarge(key: string, maxBytes: number): InvokeError {
    return new InvokeError(
      "ERR_BLOB_TOO_LARGE",
      `${this.bound.describe}: the content for '${key}' is over the ${maxBytes} bytes 'maxBytes' allows; nothing was stored.`,
      { key, maxBytes },
    );
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export async function create(resource: OperationResource, ctx: ResourceContext): Promise<BlobPut> {
  return new BlobPut(new BoundOperation("Blob.Put", resource, ctx));
}
