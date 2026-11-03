import { createHash } from "node:crypto";
import type { CancellationToken, ResourceContext } from "@telorun/sdk";
import type { SqlConnection } from "@telorun/sql";

/**
 * The `LISTEN`/`NOTIFY` half a connection may offer, declared structurally —
 * `Postgres.Connection` answers it as convention methods on its instance, which
 * the neutral `Sql.Connection` contract does not carry. A connection without it
 * is a queue that polls: a wake only makes a claim prompt, never correct.
 */
export interface NotifyingConnection extends SqlConnection {
  listen(channel: string, onNotify: (payload: string | undefined) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload?: string): Promise<void>;
}

export function canNotify(connection: SqlConnection): connection is NotifyingConnection {
  const candidate = connection as Partial<NotifyingConnection>;
  return typeof candidate.listen === "function" && typeof candidate.notify === "function";
}

/** How long a failed subscription waits before a later claim tries again. */
const RESUBSCRIBE_AFTER_MS = 30_000;

/**
 * One queue's wake channel: notifications sent when a message may have become
 * claimable, and the subscription a claimer waits on.
 *
 * The channel is derived from the table and the queue's name, so every process
 * serving one queue shares it and two queues never do. A counter of
 * notifications received lets a claimer wait only for one that arrived after
 * its own claim began — one that arrived earlier was already visible to it.
 */
export class QueueWake {
  readonly channel: string;
  private received = 0;
  private readonly waiters = new Set<() => void>();
  private subscribed = false;
  private subscribing: Promise<void> | undefined;
  private retryAt = 0;

  constructor(
    private readonly connection: NotifyingConnection,
    private readonly ctx: ResourceContext,
    table: string,
    name: string,
  ) {
    const digest = createHash("sha256").update(`${table}\u0000${name}`).digest("hex");
    this.channel = `telo_queue_${digest.slice(0, 32)}`;
  }

  /** The count of notifications received so far — what a claim waits past. */
  mark(): number {
    return this.received;
  }

  /**
   * Subscribe on first use. The subscription is an effect on the queue's own
   * frame, closed when the queue unwinds. A failure is reported and retried by
   * a later claim; until then the queue polls.
   */
  async subscribe(): Promise<boolean> {
    if (this.subscribed) return true;
    if (Date.now() < this.retryAt) return false;
    this.subscribing ??= this.ctx
      .effect("queue wake subscription", async () => {
        const unlisten = await this.connection.listen(this.channel, () => this.notified());
        this.subscribed = true;
        return {
          result: undefined,
          inverse: async () => {
            this.subscribed = false;
            await unlisten();
          },
        };
      })
      .perform()
      .then(
        () => undefined,
        (error: unknown) => {
          this.retryAt = Date.now() + RESUBSCRIBE_AFTER_MS;
          this.ctx.log.warn(
            "Subscribing to the queue's wake notifications failed; claims poll until a later claim subscribes",
            { "telo.queue.wake.channel": this.channel },
            { error },
          );
        },
      )
      .finally(() => {
        this.subscribing = undefined;
      });
    await this.subscribing;
    return this.subscribed;
  }

  /**
   * Wait until a notification newer than `mark` has arrived, `ms` has passed,
   * or `cancellation` fires. Answers whether a notification arrived.
   */
  wait(mark: number, ms: number, cancellation: CancellationToken): Promise<boolean> {
    if (this.received !== mark) return Promise.resolve(true);
    if (ms <= 0 || cancellation.isCancelled) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopListening: () => void = () => {};
      const finish = (notified: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(onNotify);
        stopListening();
        resolve(notified);
      };
      const onNotify = () => finish(true);
      this.waiters.add(onNotify);
      timer = setTimeout(() => finish(false), ms);
      stopListening = cancellation.onCancelled(() => finish(false));
    });
  }

  /** Send a wake. Inside a transaction the database holds it until commit. */
  async notify(): Promise<void> {
    await this.connection.notify(this.channel);
  }

  private notified(): void {
    this.received++;
    for (const waiter of [...this.waiters]) waiter();
  }
}
