import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface TeeResource {
  metadata: { name: string; module?: string };
}

interface TeeInputs {
  input: AsyncIterable<unknown>;
}

interface TeeOutputs {
  outputA: Stream<unknown>;
  outputB: Stream<unknown>;
}

/**
 * Tiny FIFO with O(1) push/dequeue. Backed by an array + head pointer; the
 * array is sliced down once the head has wasted more than half the storage.
 * Avoids the O(n) reindexing cost of `Array.prototype.shift` so the Tee's
 * total drain stays O(n) rather than O(n²) for long streams.
 */
class Queue<T> {
  private items: T[] = [];
  private head = 0;

  push(value: T): void {
    this.items.push(value);
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined;
    const value = this.items[this.head] as T;
    this.items[this.head++] = undefined as unknown as T;
    if (this.head > 32 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  get length(): number {
    return this.items.length - this.head;
  }

  clear(): void {
    this.items.length = 0;
    this.head = 0;
  }
}

/**
 * Fan one async iterable out to two consumers. Each output sees every item
 * from the source. Source is pulled lazily — at most one source `next()` is
 * in flight at any time (concurrent consumer pulls are serialized via an
 * internal lock). Items are buffered in memory for the consumer that's
 * iterating slower; buffer is bounded by the source stream's length.
 *
 * Early-cancellation semantics: consumers that close early (`break` out of
 * `for await`, abort an HTTP response, etc.) trigger the iterator's
 * `return()`/`throw()`. The closed side's buffer is cleared and subsequent
 * source items skip its buffer entirely, so a stalled consumer never causes
 * unbounded memory growth on the running side. Once both sides are closed,
 * the source iterator's own `return()` / `throw()` is called to propagate
 * cancellation upstream.
 */
class TeeFanout<T> {
  private readonly bufferA = new Queue<T>();
  private readonly bufferB = new Queue<T>();
  private readonly sourceIter: AsyncIterator<T>;
  private done = false;
  private error: unknown = null;
  private pulling: Promise<void> | null = null;
  private closedA = false;
  private closedB = false;

  constructor(source: AsyncIterable<T>) {
    this.sourceIter = source[Symbol.asyncIterator]();
  }

  async next(side: "A" | "B"): Promise<IteratorResult<T>> {
    while (true) {
      if (this.isClosed(side)) {
        return { value: undefined as unknown as T, done: true };
      }
      const buf = side === "A" ? this.bufferA : this.bufferB;
      if (buf.length > 0) return { value: buf.shift() as T, done: false };
      if (this.error !== null) throw this.error;
      if (this.done) return { value: undefined as unknown as T, done: true };

      if (this.pulling) {
        await this.pulling;
        continue;
      }

      let release!: () => void;
      this.pulling = new Promise<void>((r) => {
        release = r;
      });
      try {
        const result = await this.sourceIter.next();
        if (result.done) {
          this.done = true;
        } else {
          if (!this.closedA) this.bufferA.push(result.value);
          if (!this.closedB) this.bufferB.push(result.value);
        }
      } catch (err) {
        this.error = err;
      } finally {
        this.pulling = null;
        release();
      }
    }
  }

  async return(side: "A" | "B"): Promise<IteratorResult<T>> {
    this.markClosed(side);
    if (this.bothClosed() && !this.done) {
      this.done = true;
      if (this.sourceIter.return) {
        return (await this.sourceIter.return()) as IteratorResult<T>;
      }
    }
    return { value: undefined as unknown as T, done: true };
  }

  async throw(side: "A" | "B", err: unknown): Promise<IteratorResult<T>> {
    this.markClosed(side);
    if (this.bothClosed() && !this.done) {
      this.done = true;
      if (this.sourceIter.throw) {
        return (await this.sourceIter.throw(err)) as IteratorResult<T>;
      }
    }
    throw err;
  }

  private isClosed(side: "A" | "B"): boolean {
    return side === "A" ? this.closedA : this.closedB;
  }

  private bothClosed(): boolean {
    return this.closedA && this.closedB;
  }

  private markClosed(side: "A" | "B"): void {
    if (side === "A") {
      this.closedA = true;
      this.bufferA.clear();
    } else {
      this.closedB = true;
      this.bufferB.clear();
    }
  }

  iterable(side: "A" | "B"): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        return {
          next: () => self.next(side),
          return: () => self.return(side),
          throw: (err: unknown) => self.throw(side, err),
        };
      },
    };
  }
}

class Tee implements ResourceInstance<TeeInputs, TeeOutputs> {
  constructor(private readonly resource: TeeResource) {}

  async invoke(inputs: TeeInputs): Promise<TeeOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `RecordStream.Tee "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    const fanout = new TeeFanout<unknown>(input);
    return {
      outputA: new Stream(fanout.iterable("A")),
      outputB: new Stream(fanout.iterable("B")),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: TeeResource,
  _ctx: ResourceContext,
): Promise<Tee> {
  return new Tee(resource);
}
