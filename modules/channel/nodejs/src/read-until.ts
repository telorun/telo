import {
  InvokeError,
  parseDurationMs,
  type ResourceContext,
  type ResourceInstance,
  type TextChannel,
} from "@telorun/sdk";

/**
 * How much unread output one channel retains.
 *
 * A constant rather than a field, because no outcome depends on its value. With
 * no read waiting, a full buffer stops taking the program's output and the
 * program blocks — ordinary pipe back-pressure, what `cmd | head` does. With a
 * read waiting, a full buffer means the marker is further away than the buffer
 * can hold, which waiting cannot fix, so the read fails. Neither path drops
 * text, so the size is throughput, not correctness.
 */
const BUFFER_LIMIT = 1024 * 1024;

/** How long the drain pauses while a full buffer has no reader. */
const BACK_PRESSURE_PAUSE_MS = 10;

interface ReadUntilResource {
  metadata: { name: string };
  channel: unknown;
  timeout?: string;
}

interface ReadUntilInputs {
  until: string;
}

/**
 * Reads a channel up to a marker.
 *
 * The buffer and the cursor live HERE rather than on the channel, which is what
 * makes "a channel nobody reads retains nothing" true by construction: a channel
 * hands over its output only when asked, and it is asked only when a reader is
 * created. Draining starts at creation — before the program runs — so the first
 * prompt is in the buffer rather than lost to a reader that attached too late.
 */
export class ReadUntil implements ResourceInstance<ReadUntilInputs, { text: string }> {
  #pending = "";
  #ended = false;
  #failure?: InvokeError;
  #waiting?: () => void;
  #reading = false;

  constructor(
    private readonly resource: ReadUntilResource,
    private readonly channel: TextChannel,
    private readonly timeoutMs: number,
  ) {
    void this.#drain();
  }

  async invoke(inputs: ReadUntilInputs): Promise<{ text: string }> {
    if (this.#reading) {
      throw new InvokeError(
        "ERR_CHANNEL_CONCURRENT_READ",
        `Channel.ReadUntil "${this.resource.metadata.name}": a read is already waiting. ` +
          `Reads consume what they return, so two at once would interleave and which one ` +
          `saw a given line would depend on scheduling — order them in one sequence.`,
      );
    }
    this.#reading = true;
    try {
      return await this.#readUntil(inputs.until);
    } finally {
      this.#reading = false;
    }
  }

  async #readUntil(until: string): Promise<{ text: string }> {
    const deadline = Date.now() + this.timeoutMs;

    while (true) {
      const at = this.#pending.indexOf(until);
      if (at !== -1) {
        const text = this.#pending.slice(0, at + until.length);
        // Consumed through the marker: leaving it in place would match it again
        // on the next read, forever.
        this.#pending = this.#pending.slice(at + until.length);
        return { text };
      }
      if (this.#failure) throw this.#failure;
      if (this.#pending.length >= BUFFER_LIMIT) {
        throw new InvokeError(
          "ERR_CHANNEL_OVERFLOW",
          `Channel.ReadUntil "${this.resource.metadata.name}": read ${BUFFER_LIMIT} bytes ` +
            `without finding ${JSON.stringify(until)}. Waiting longer cannot help — the ` +
            `marker is further away than a channel retains.`,
          { head: this.#pending.slice(0, 2000) },
        );
      }
      if (this.#ended) {
        throw new InvokeError(
          "ERR_CHANNEL_CLOSED",
          `Channel.ReadUntil "${this.resource.metadata.name}": the program's output ended ` +
            `while waiting for ${JSON.stringify(until)}. Read before it ended: ` +
            `${JSON.stringify(this.#pending)}.`,
          { side: "output", text: this.#pending },
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new InvokeError(
          "ERR_CHANNEL_READ_TIMEOUT",
          `Channel.ReadUntil "${this.resource.metadata.name}": waited ${this.timeoutMs}ms ` +
            `for ${JSON.stringify(until)} and it did not arrive. Read while waiting: ` +
            `${JSON.stringify(this.#pending.slice(-2000))}.`,
          { text: this.#pending },
        );
      }
      await this.#awaitMore(remaining);
    }
  }

  /** Wakes on the next chunk, on the output ending, or on the deadline. */
  async #awaitMore(withinMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting = undefined;
        resolve();
      }, withinMs);
      this.#waiting = () => {
        clearTimeout(timer);
        this.#waiting = undefined;
        resolve();
      };
    });
  }

  async #drain(): Promise<void> {
    try {
      for await (const chunk of this.channel.openOutput()) {
        this.#pending += chunk;
        this.#waiting?.();
        while (this.#pending.length >= BUFFER_LIMIT) {
          await new Promise<void>((resolve) => setTimeout(resolve, BACK_PRESSURE_PAUSE_MS));
        }
      }
    } catch (err) {
      this.#failure =
        err instanceof InvokeError
          ? err
          : new InvokeError(
              "ERR_CHANNEL_CLOSED",
              `Channel.ReadUntil "${this.resource.metadata.name}": reading the program's ` +
                `output failed: ${err instanceof Error ? err.message : String(err)}`,
              { side: "output", text: this.#pending },
            );
    } finally {
      this.#ended = true;
      this.#waiting?.();
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const schema = { type: "object", additionalProperties: true };

export async function create(
  resource: ReadUntilResource,
  ctx: ResourceContext,
): Promise<ReadUntil> {
  const channel = ctx.resolveRef<TextChannel>(
    resource.channel,
    (value): value is TextChannel =>
      typeof (value as TextChannel)?.openOutput === "function",
    () => `Channel.ReadUntil "${resource.metadata.name}" channel`,
    "Channel.Text",
  );
  return new ReadUntil(resource, channel, parseDurationMs(resource.timeout ?? "30s"));
}
