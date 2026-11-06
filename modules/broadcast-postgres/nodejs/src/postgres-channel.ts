import type {
  BroadcastChannel,
  BroadcastListener,
  BroadcastSettings,
  BroadcastSubscriptionHandle,
} from "@telorun/broadcast";
import type { InvokeContext, ResourceContext, ResourceInstance, ZoneEntry } from "@telorun/sdk";

/** The largest notification payload PostgreSQL accepts, in bytes. */
export const NOTIFICATION_PAYLOAD_LIMIT = 7999;

/** The prefix of the notification channel a broadcast channel is carried on. */
export const NOTIFICATION_CHANNEL_PREFIX = "telo_broadcast_";

/** What the channel needs of a `Postgres.Connection`, declared structurally:
 *  `listen` / `notify` are its convention methods, the rest the SQL contract. */
export interface PostgresConnection extends ResourceInstance {
  listen(
    channel: string,
    onNotify: (payload: string | undefined) => void,
    options?: { onReconnect?: () => void },
  ): Promise<() => Promise<void>>;
  notify(channel: string, payload?: string): Promise<void>;
  execute(sql: string, params?: unknown[], zone?: ZoneEntry, ctx?: InvokeContext): Promise<unknown>;
  bindsZone(zone: ZoneEntry): boolean;
}

export function isPostgresConnection(value: unknown): value is PostgresConnection {
  const candidate = value as Partial<Record<keyof PostgresConnection, unknown>> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (["listen", "notify", "execute", "bindsZone"] as const).every(
      (method) => typeof candidate[method] === "function",
    )
  );
}

/**
 * A broadcast channel on one PostgreSQL notification channel. Every subscription
 * of this instance shares ONE `LISTEN`, opened with the first and released with
 * the last; the topic travels in the payload and the subscriber matches it.
 */
export class PostgresBroadcastChannel implements BroadcastChannel, ResourceInstance {
  readonly #listeners = new Set<BroadcastListener>();
  #listening: Promise<() => Promise<void>> | undefined;

  constructor(
    private readonly channelSettings: BroadcastSettings,
    private readonly connection: PostgresConnection,
    private readonly ctx: ResourceContext,
  ) {}

  settings(): BroadcastSettings {
    return this.channelSettings;
  }

  get notificationChannel(): string {
    return NOTIFICATION_CHANNEL_PREFIX + this.channelSettings.name;
  }

  async publish(payload: string, invokeCtx?: InvokeContext): Promise<void> {
    const zone = this.ctx.zonesFor(this.connection, invokeCtx).find((entry) => this.connection.bindsZone(entry));
    if (zone) {
      // NOTIFY inside the caller's transaction: the server delivers it at commit
      // and drops it at rollback.
      await this.connection.execute("SELECT pg_notify($1, $2)", [this.notificationChannel, payload], zone, invokeCtx);
      return;
    }
    await this.connection.notify(this.notificationChannel, payload);
  }

  async subscribe(listener: BroadcastListener): Promise<BroadcastSubscriptionHandle> {
    this.#listeners.add(listener);
    try {
      await this.listening();
    } catch (error) {
      this.#listeners.delete(listener);
      throw error;
    }
    return {
      close: async () => {
        this.#listeners.delete(listener);
        if (this.#listeners.size > 0 || !this.#listening) return;
        const unlisten = this.#listening;
        this.#listening = undefined;
        await (await unlisten)();
      },
    };
  }

  async provide(): Promise<PostgresBroadcastChannel> {
    return this;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }

  private listening(): Promise<() => Promise<void>> {
    if (!this.#listening) {
      const opened = this.connection.listen(
        this.notificationChannel,
        (payload) => {
          for (const listener of [...this.#listeners]) listener.receive(payload ?? "");
        },
        {
          onReconnect: () => {
            for (const listener of [...this.#listeners]) {
              listener.gap("the database connection was lost and re-established");
            }
          },
        },
      );
      this.#listening = opened;
      // A failed LISTEN is not remembered: the next subscriber tries again.
      opened.catch(() => {
        if (this.#listening === opened) this.#listening = undefined;
      });
    }
    return this.#listening;
  }
}
