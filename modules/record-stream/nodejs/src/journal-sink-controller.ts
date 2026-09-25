import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, isInvokeError } from "@telorun/sdk";
import {
  ERR_JOURNAL_KEY_BUSY,
  ERR_JOURNAL_KEY_REMOVED,
  ERR_JOURNAL_WRITER_LOST,
  type Journal,
  type JournalWriter,
  isJournal,
} from "./journal.js";

interface JournalSinkResource {
  metadata: { name: string; module?: string };
  journal?: Journal | KindRef<Journal>;
}

interface JournalSinkInputs {
  key: string;
  input: AsyncIterable<unknown>;
}

interface JournalSinkOutputs {
  key: string;
  count: number;
}

/** The longest delay a Node timer honours; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const REFUSALS = new Set([ERR_JOURNAL_KEY_BUSY, ERR_JOURNAL_KEY_REMOVED, ERR_JOURNAL_WRITER_LOST]);

/** A refusal means the key is not this writer's to settle; anything else is the
 *  drain failing, which the key records. */
function isRefusal(err: unknown): boolean {
  return isInvokeError(err) && REFUSALS.has(err.code);
}

/**
 * RecordStream.JournalSink — claim a key, then drain a stream into it. The claim
 * comes before the first record is pulled, and a heartbeat runs every third of
 * the journal's writer timeout for as long as the drain does, records or not.
 * The writer's store operations run one at a time, so a heartbeat never races an
 * append for the version. A refused write stops the drain, cancels the input and
 * raises its code; an input error fails the key and is rethrown unchanged —
 * outside the kind's declared `throws:`, since it is whatever the producer raised.
 */
class JournalSink implements ResourceInstance<JournalSinkInputs, JournalSinkOutputs> {
  constructor(
    private readonly resource: JournalSinkResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: JournalSinkInputs): Promise<JournalSinkOutputs> {
    const name = this.resource.metadata.name;
    const { key, input } = inputs;
    if (!input || typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      throw new InvokeError("ERR_INVALID_INPUT", `RecordStream.JournalSink "${name}": 'input' must be a stream.`);
    }
    const journal = this.ctx.resolveRef(
      this.resource.journal,
      isJournal,
      () => `RecordStream.JournalSink "${name}": 'journal'`,
      "Self.Journal",
    );
    const writer = await journal.claim(key);
    return this.drain(writer, input, journal.settings.writerTimeoutMs / 3);
  }

  private async drain(
    writer: JournalWriter,
    input: AsyncIterable<unknown>,
    heartbeatMs: number,
  ): Promise<JournalSinkOutputs> {
    // One store operation at a time, in order.
    let queue: Promise<unknown> = Promise.resolve();
    const serialize = <T>(op: () => Promise<T>): Promise<T> => {
      const run = queue.then(op);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };

    // Set when a heartbeat is refused, so the drain pulls no further record.
    let stopReason: { error: unknown } | undefined;
    let rejectStopped: (err: unknown) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const stop = (err: unknown) => {
      stopReason ??= { error: err };
      rejectStopped(err);
    };
    // Observed by the race below; this only keeps an early stop from reading as
    // an unhandled rejection before the race is entered.
    stopped.catch(() => undefined);

    const heartbeat = setInterval(() => {
      serialize(() => writer.touch()).catch(stop);
    }, Math.min(heartbeatMs, MAX_TIMER_MS));
    heartbeat.unref();

    const iterator = input[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<unknown>> | undefined;
    let count = 0;
    try {
      while (true) {
        if (stopReason) throw stopReason.error;
        pending = iterator.next();
        const step = await Promise.race([pending, stopped]);
        pending = undefined;
        if (step.done) break;
        await serialize(() => writer.append(step.value));
        count++;
      }
      clearInterval(heartbeat);
      await serialize(() => writer.finish());
      return { key: writer.key, count };
    } catch (err) {
      clearInterval(heartbeat);
      if (!isRefusal(err)) {
        try {
          const note = await serialize(() => writer.fail(err));
          if (note.dataNotRecorded) {
            this.ctx.log.warn("RecordStream.JournalSink recorded the drain's failure without its data", {
              key: writer.key,
              reason: note.dataNotRecorded,
            });
          }
        } catch (recordErr) {
          this.ctx.log.error("RecordStream.JournalSink could not record the drain's failure on its key", {
            key: writer.key,
            error: recordErr instanceof Error ? recordErr.message : String(recordErr),
          });
        }
        throw err;
      }
      await this.cancel(iterator, pending, writer.key);
      throw err;
    }
  }

  /** Stop the input after a refusal. A pull still in flight cannot be awaited —
   *  the input may be paused indefinitely — so its outcome is logged instead. */
  private async cancel(
    iterator: AsyncIterator<unknown>,
    pending: Promise<IteratorResult<unknown>> | undefined,
    key: string,
  ): Promise<void> {
    const report = (err: unknown) =>
      this.ctx.log.warn("RecordStream.JournalSink's input failed after its key was refused", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    if (!iterator.return) return;
    if (pending) {
      pending.catch(report);
      iterator.return().catch(report);
      return;
    }
    await iterator.return().catch(report);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(resource: JournalSinkResource, ctx: ResourceContext): Promise<JournalSink> {
  return new JournalSink(resource, ctx);
}
