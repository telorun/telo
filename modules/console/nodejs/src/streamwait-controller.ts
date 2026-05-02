import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

interface StreamWaitResource {
  metadata: { name: string; module?: string };
  prefix?: string;
  frames?: string[];
  intervalMs?: number;
}

interface StreamWaitInputs {
  input: AsyncIterable<unknown>;
}

interface StreamWaitOutputs {
  output: Stream<unknown>;
}

/**
 * Animate a single-cell frame sequence on stdout while waiting for the
 * first item from the input stream, then clear the cell and forward
 * every item unchanged. Bytes flow through the output stream — the
 * controller does not write to stdout directly. The downstream
 * Console.WriteStream (or any other consumer) is the sole writer.
 */
class StreamWait implements ResourceInstance<StreamWaitInputs, StreamWaitOutputs> {
  private readonly prefix: string;
  private readonly frames: string[];
  private readonly intervalMs: number;

  constructor(private readonly resource: StreamWaitResource) {
    this.prefix = resource.prefix ?? "";
    this.frames = resource.frames && resource.frames.length > 0 ? resource.frames : DEFAULT_FRAMES;
    this.intervalMs = resource.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.validateConfig();
  }

  async invoke(inputs: StreamWaitInputs): Promise<StreamWaitOutputs> {
    const name = this.resource.metadata.name;
    const source = inputs?.input;
    if (!source || typeof (source as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Console.StreamWait "${name}": 'input' must be an AsyncIterable.`,
      );
    }

    const prefix = this.prefix;
    const frames = this.frames;
    const intervalMs = this.intervalMs;

    async function* gen(): AsyncIterable<unknown> {
      // Reserve the animation cell. ' \b' = space at the cursor's column,
      // then \b backs the cursor up over it so frames overwrite the same cell.
      yield prefix + " \b";
      // Paint frame 0 immediately so there's no `intervalMs` blank gap.
      yield frames[0] + "\b";

      const reader = source[Symbol.asyncIterator]();
      const firstPull = reader.next();
      // Attach a no-op rejection handler so a late-settling firstPull —
      // possible if the consumer cancels us while we're awaiting the
      // race below — doesn't surface as an unhandled rejection. The
      // try/catch around the race handler still receives the error
      // synchronously when the race is what wakes us up.
      firstPull.catch(() => {});

      let i = 1;
      let firstResult: IteratorResult<unknown> | undefined;
      let activeTimer: ReturnType<typeof setTimeout> | null = null;
      let readerExhausted = false;

      try {
        // --- Wait loop ---
        while (firstResult === undefined) {
          const sleep = new Promise<void>((resolve) => {
            activeTimer = setTimeout(() => {
              activeTimer = null;
              resolve();
            }, intervalMs);
          });
          let winner: { kind: "first"; r: IteratorResult<unknown> } | { kind: "tick" };
          try {
            winner = await Promise.race([
              firstPull.then((r) => ({ kind: "first" as const, r })),
              sleep.then(() => ({ kind: "tick" as const })),
            ]);
          } catch (err) {
            // Source rejected before yielding its first item. Wipe the
            // animation cell BEFORE the error propagates so the failure
            // doesn't surface next to a half-painted frame.
            yield " \b";
            // Reader has already errored — skip the cleanup .return() in finally.
            readerExhausted = true;
            throw err;
          }
          if (winner.kind === "first") {
            firstResult = winner.r;
          } else {
            yield frames[i++ % frames.length] + "\b";
          }
        }

        // Clear the animation cell. Cursor stays parked on the cell so
        // the first forwarded item (if any) lands on a freshly-cleared column.
        yield " \b";

        // --- Forwarding loop ---
        if (firstResult.done) {
          readerExhausted = true;
          return;
        }
        yield firstResult.value;

        while (true) {
          const next = await reader.next();
          if (next.done) {
            readerExhausted = true;
            return;
          }
          yield next.value;
        }
      } finally {
        if (activeTimer !== null) clearTimeout(activeTimer);
        // Propagate cancellation upstream on every early-exit path
        // (consumer break, downstream throw, our own re-throw). Because
        // the generator manually drives reader.next(), the implicit
        // for-await cancellation forwarding doesn't happen on its own.
        // Skip when the reader has already drained or errored.
        if (!readerExhausted && reader.return) {
          await reader.return();
        }
      }
    }

    return { output: new Stream(gen()) };
  }

  snapshot(): Record<string, unknown> {
    return {
      prefix: this.prefix,
      frames: this.frames,
      intervalMs: this.intervalMs,
    };
  }

  private validateConfig(): void {
    const name = this.resource.metadata.name;

    for (const ch of ["\n", "\r", "\b", "\x1b"]) {
      if (this.prefix.includes(ch)) {
        throw new InvokeError(
          "ERR_INVALID_CONFIG",
          `Console.StreamWait "${name}": 'prefix' must not contain control characters (\\n, \\r, \\b, \\x1b).`,
        );
      }
    }

    for (let i = 0; i < this.frames.length; i++) {
      const frame = this.frames[i];
      if (typeof frame !== "string" || frame.length !== 1) {
        throw new InvokeError(
          "ERR_INVALID_CONFIG",
          `Console.StreamWait "${name}": frames[${i}] must be a single-character string (length === 1); got ${JSON.stringify(frame)}.`,
        );
      }
    }

    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 16) {
      throw new InvokeError(
        "ERR_INVALID_CONFIG",
        `Console.StreamWait "${name}": 'intervalMs' must be an integer >= 16; got ${this.intervalMs}.`,
      );
    }
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: StreamWaitResource,
  _ctx: ResourceContext,
): Promise<StreamWait> {
  return new StreamWait(resource);
}
