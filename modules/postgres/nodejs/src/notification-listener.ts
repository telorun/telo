/**
 * `LISTEN` / `NOTIFY` over a connection of its own.
 *
 * **Not a pool checkout.** A listener holds its connection for as long as it is
 * subscribed, so taking one from the pool would permanently consume one of
 * `max` — and kysely hands out no raw `pg.Client` to attach a `notification`
 * handler to anyway. This opens its own client from the same configuration, so
 * a caller declares one `connectionString` and gets both halves.
 *
 * **A wake is an optimization, never the correctness path.** The consumer this
 * exists for — a durable journal's resumer — already polls, and a notification
 * only makes it prompt. So a dropped connection reconnects and re-subscribes on
 * a bounded backoff and the failure is REPORTED rather than raised: raising it
 * would take down an application over a lost optimization, and swallowing it
 * would leave a listener silently dead. What is never swallowed is a failure to
 * subscribe in the first place — that one reaches the caller, because a
 * subscription nobody established is a subscription the caller thinks it has.
 */
import type { Logger } from "@telorun/sdk";
import { Client, type ClientConfig } from "pg";

/** What a notification carries: Postgres delivers a channel and an optional
 *  payload string, and nothing else. A payload larger than 8000 bytes is
 *  rejected by the server, so a consumer sends an address and reads the body
 *  from its own store rather than shipping it here. */
export type NotificationHandler = (payload: string | undefined) => void;

const INITIAL_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 30_000;

export class NotificationListener {
  readonly #handlers = new Map<string, Set<NotificationHandler>>();
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  #reconnectDelay = INITIAL_RECONNECT_MS;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(
    private readonly config: ClientConfig,
    private readonly log: Logger,
  ) {}

  /**
   * Subscribe to a channel, returning the unsubscribe.
   *
   * Several handlers may share one channel — `LISTEN` is per connection, not per
   * handler, so the statement runs once and the last handler to leave is what
   * issues `UNLISTEN`.
   */
  async listen(channel: string, onNotify: NotificationHandler): Promise<() => Promise<void>> {
    if (this.#closed) {
      throw new Error("Postgres.Connection: listen() after the connection was torn down");
    }
    const quoted = quoteChannel(channel);
    const existing = this.#handlers.get(channel);
    if (existing) {
      existing.add(onNotify);
    } else {
      this.#handlers.set(channel, new Set([onNotify]));
      try {
        const client = await this.connect();
        await client.query(`LISTEN ${quoted}`);
      } catch (err) {
        // Roll the registration back before rethrowing: leaving it behind would
        // resubscribe a caller that believes it never subscribed.
        this.#handlers.delete(channel);
        throw err;
      }
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const handlers = this.#handlers.get(channel);
      if (!handlers) return;
      handlers.delete(onNotify);
      if (handlers.size > 0) return;
      this.#handlers.delete(channel);
      // Best-effort: a client that is already gone has no subscription left to
      // drop, and reconnecting merely to unsubscribe would be work in the
      // opposite direction.
      try {
        await this.#client?.query(`UNLISTEN ${quoted}`);
      } catch (err) {
        this.log.debug("postgres UNLISTEN failed; subscription dropped locally", undefined, {
          error: err,
        });
      }
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    // A connect already in flight is AWAITED, not abandoned. Dropping the
    // reference would leave a client that connects a moment later holding an
    // open socket nobody owns and nothing ends — and an open socket keeps the
    // event loop alive, so the app that just tore this down would not exit.
    // `open()` also refuses to publish a client once closed, so the two halves
    // agree however the race lands.
    const connecting = this.#connecting?.catch(() => undefined) ?? Promise.resolve(undefined);
    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    await Promise.all([end(client, this.log), connecting.then((c) => end(c, this.log))]);
  }

  private async connect(): Promise<Client> {
    if (this.#client) return this.#client;
    // One in-flight connect, shared: two concurrent `listen()` calls on a cold
    // listener would otherwise each open a client and one would be orphaned.
    this.#connecting ??= this.open().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  private async open(): Promise<Client> {
    const client = new Client(this.config);
    // Attached BEFORE connect: `pg` emits `error` on a client whose socket dies,
    // and an EventEmitter with no `error` listener terminates the process.
    client.on("error", (error) => {
      this.log.debug("postgres listener connection failed", undefined, { error });
      this.dropAndReconnect(client);
    });
    client.on("end", () => this.dropAndReconnect(client));
    client.on("notification", (message) => {
      for (const handler of this.#handlers.get(message.channel) ?? []) {
        handler(message.payload === "" ? undefined : (message.payload ?? undefined));
      }
    });
    await client.connect();
    // Closed while this was connecting: the client is ended here rather than
    // published, because `close()` has already taken whatever it could see and
    // will never look again.
    if (this.#closed) {
      await end(client, this.log);
      throw new Error("Postgres.Connection: the listener was torn down while connecting");
    }
    this.#client = client;
    this.#reconnectDelay = INITIAL_RECONNECT_MS;
    return client;
  }

  /**
   * Re-open and re-subscribe after a drop.
   *
   * Every subscription is replayed, because `LISTEN` is a property of the
   * connection that carried it: a new connection starts subscribed to nothing,
   * so a listener that reconnected without replaying would be attached and deaf
   * — the failure mode that reads as "notifications stopped arriving" with
   * nothing in the log.
   */
  private dropAndReconnect(dead: Client): void {
    if (this.#closed || this.#client !== dead) return;
    this.#client = undefined;
    if (this.#handlers.size === 0) return;
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
    this.#reconnectTimer = setTimeout(() => {
      if (this.#closed || this.#handlers.size === 0) return;
      void this.connect()
        .then(async (client) => {
          for (const channel of this.#handlers.keys()) {
            await client.query(`LISTEN ${quoteChannel(channel)}`);
          }
          this.log.debug("postgres listener reconnected", {
            "db.listen.channels": this.#handlers.size,
          });
        })
        .catch((error) => {
          this.log.debug("postgres listener reconnect failed; retrying", undefined, { error });
          this.#client = dead;
          this.dropAndReconnect(dead);
        });
    }, delay);
    // A reconnect must never be the reason the process stays alive — kernel
    // holds decide when an app exits.
    this.#reconnectTimer.unref();
  }
}

/** End a client, reporting rather than raising: this is only ever reached while
 *  tearing down, where a failure to close changes nothing a caller can act on. */
async function end(client: Client | undefined, log: Logger): Promise<void> {
  if (!client) return;
  try {
    await client.end();
  } catch (err) {
    log.debug("postgres listener close failed", undefined, { error: err });
  }
}

/** A channel name is an IDENTIFIER, not a bindable parameter: `LISTEN` takes no
 *  placeholder, so the name is quoted the way every other identifier in this
 *  module is rather than interpolated raw. */
function quoteChannel(channel: string): string {
  return `"${channel.replace(/"/g, '""')}"`;
}
