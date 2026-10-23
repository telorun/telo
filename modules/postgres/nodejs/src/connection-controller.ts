import { integerInput, toPlainJson, type Logger, type ResourceContext } from "@telorun/sdk";
import { quoteAnsiIdentifier, SqlConnectionBase, type SqlDialect } from "@telorun/sql";
import { CompiledQuery, Kysely, PostgresDialect } from "kysely";
import { Pool, type ClientConfig } from "pg";
import { NotificationListener, type NotificationHandler } from "./notification-listener.js";

interface PoolConfig {
  min?: number;
  max?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  maxLifetimeMs?: number;
  healthCheckMs?: number;
}

interface PostgresConnectionManifest {
  metadata: { name: string; module: string };
  pool?: { readonly [field in keyof PoolConfig]?: number | bigint };
}

const POOL_FIELDS = [
  "min",
  "max",
  "idleTimeoutMs",
  "connectionTimeoutMs",
  "maxLifetimeMs",
  "healthCheckMs",
] as const satisfies readonly (keyof PoolConfig)[];

/** A `!cel` integer arrives as an int64 and a literal as a number; the pool and
 *  its timers take a number either way. */
function poolConfigOf(manifest: PostgresConnectionManifest): PoolConfig | undefined {
  if (!manifest.pool) return undefined;
  const config: PoolConfig = {};
  for (const field of POOL_FIELDS) {
    const raw = manifest.pool[field];
    if (raw === undefined) continue;
    const value = integerInput(raw);
    if (value === undefined) {
      throw new Error(
        `Postgres.Connection "${manifest.metadata.name}": 'pool.${field}' must be an integer a number can hold, got ${String(raw)}.`,
      );
    }
    config[field] = value;
  }
  return config;
}

/** The slot holding the database-access fulfilment. */
const ACCESS = "/access";

/** Each feature `DatabaseAccess` lists, by the extension that provides it. */
const FEATURE_EXTENSIONS: Readonly<Record<string, string>> = {
  pgvector: "vector",
  postgis: "postgis",
};

/**
 * `server_version_num` as semver: `MMmmmm` from PostgreSQL 10 on, whose version is
 * major.minor with no third part, and `MMmmpp` before it.
 */
function serverVersionText(versionNum: number): string {
  const major = Math.floor(versionNum / 10_000);
  if (major >= 10) return `${major}.${versionNum % 10_000}.0`;
  return `${major}.${Math.floor((versionNum % 10_000) / 100)}.${versionNum % 100}`;
}

/** The `DatabaseAccess` features the server can provide: an extension that is
 *  available, installed or not, since an application may create it itself. */
function featuresOf(availableExtensions: readonly string[]): string[] {
  return Object.entries(FEATURE_EXTENSIONS)
    .filter(([, extension]) => availableExtensions.includes(extension))
    .map(([feature]) => feature);
}

const DEFAULT_HEALTH_CHECK_MS = 60_000;

type SslOption =
  | false
  | { rejectUnauthorized: boolean; checkServerIdentity?: () => undefined };

function sslFromSslmode(mode: string | null): SslOption {
  switch (mode) {
    case null:
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      // libpq `verify-ca` validates the CA chain but not the hostname; Node's
      // default `checkServerIdentity` enforces the hostname, so disable it.
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      throw new Error(
        `Postgres.Connection: unsupported sslmode '${mode}'. ` +
          `Use 'disable', 'require', 'verify-ca', or 'verify-full'.`,
      );
  }
}

export const postgresDialect: SqlDialect = {
  placeholderStyle: "numbered",
  quoteIdentifier: quoteAnsiIdentifier,
  // PostgreSQL binds the whole set as one array parameter, which keeps the
  // statement text stable regardless of how many elements are matched.
  renderIn(column, values, addParam) {
    return `${column} = ANY(${addParam(values)})`;
  },
  // `clock_timestamp()` is the wall clock when evaluated; `now()` would be the
  // transaction's start.
  renderCurrentTimeMillis() {
    return "CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)";
  },
};

/**
 * Keeps every error a disconnect can raise off the process's uncaught path.
 *
 * `pg` emits `error` on the pool for a connection that dies while idle, and on
 * the client itself while it is checked out — for that window `pg-pool` detaches
 * its own listener and attaches nothing, so an ordinary disconnect would reach
 * an EventEmitter with no listener and terminate the process. The in-flight query
 * is rejected separately by `pg`, so these paths only report; they never swallow
 * a caller's failure.
 */
function handleDisconnects(pool: Pool, log: Logger): void {
  pool.on("error", (error) => {
    log.debug("postgres connection closed while idle; discarded from pool", undefined, { error });
  });
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      log.debug("postgres connection error", undefined, { error });
    });
  });
}

/**
 * Probes connections on an interval so a peer that vanished without closing the
 * socket — an evicted NAT mapping, a blackholed route, a host that never came
 * back — is discovered here rather than by the next request. A failed probe
 * rejects and `pg-pool` evicts that client.
 *
 * Each sweep probes every idle connection, plus enough extra to bring the pool
 * back up to `min`: `pg-pool` never opens connections on its own, so after a
 * disconnect the pool would otherwise sit below `min` until traffic arrived, and
 * a `min` the author declared for warm capacity would quietly stop holding.
 * Probing what is already checked out is neither possible nor useful — a busy
 * connection is proving itself.
 *
 * Returns the stop function. `0` disables the sweep.
 */
function startHealthCheck(
  pool: Pool,
  intervalMs: number,
  minConnections: number,
  log: Logger,
): () => void {
  if (intervalMs <= 0) {
    return () => {};
  }

  // A probe against a blackholed socket does not fail — it waits out the TCP
  // retransmit window, on the order of minutes. Since the sweep will not start
  // another pass while one is outstanding, an unbounded probe would disable the
  // very mechanism that exists to detect that case, so each probe gets its own
  // deadline and the sweep moves on at the next tick. The abandoned query still
  // settles eventually and releases its connection.
  const probe = (): Promise<unknown> => {
    let deadline: NodeJS.Timeout;
    const timeout = new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error(`liveness probe exceeded ${intervalMs}ms`)),
        intervalMs,
      );
      deadline.unref();
    });
    return Promise.race([pool.query("SELECT 1"), timeout]).finally(() =>
      clearTimeout(deadline),
    );
  };

  let sweeping = false;
  const timer = setInterval(() => {
    if (sweeping) return;
    const probeCount = pool.idleCount + Math.max(0, minConnections - pool.totalCount);
    if (probeCount === 0) return;

    sweeping = true;
    void Promise.allSettled(Array.from({ length: probeCount }, probe))
      .then((probes) => {
        for (const outcome of probes) {
          if (outcome.status === "rejected") {
            log.debug("postgres liveness probe failed; connection discarded", undefined, {
              error: outcome.reason,
            });
          }
        }
      })
      .finally(() => {
        sweeping = false;
      });
  }, intervalMs);
  // The sweep must never be the reason the process stays alive — kernel holds
  // decide when an app exits.
  timer.unref();

  return () => clearInterval(timer);
}

/** What `init()` opens from the need: the pool, and the configuration the
 *  notification listener opens its own client from. */
interface OpenedAccess {
  pool: Pool;
  listenerConfig: ClientConfig;
}

class PostgresConnection extends SqlConnectionBase {
  #listener: NotificationListener | undefined;
  #opened: OpenedAccess | undefined;

  constructor(
    private readonly poolConfig: PoolConfig | undefined,
    ctx: ResourceContext,
  ) {
    // kysely asks for the pool on first use, which is `init()`'s first effect —
    // after `#open` has built it from the need.
    super(
      new Kysely<any>({ dialect: new PostgresDialect({ pool: async () => this.#requireOpened().pool }) }),
      postgresDialect,
      ctx,
    );
  }

  #requireOpened(): OpenedAccess {
    if (!this.#opened) {
      throw new Error("Postgres.Connection: the pool is opened by init(), which has not run");
    }
    return this.#opened;
  }

  /**
   * The pool, built from the database-access fulfilment — which is opened from
   * `init()` on, never in `create()`. Building it reaches nothing: `pg` connects
   * when the base's first effect asks for a connection.
   */
  #open(ctx: ResourceContext): OpenedAccess {
    if (this.#opened) return this.#opened;
    // The address is a URL value; its text is what `pg` reads, every member escaped
    // by the value's own encoding.
    const url = new URL(toPlainJson(ctx.resolveNeed(ACCESS).fields.url) as string);
    const ssl = sslFromSslmode(url.searchParams.get("sslmode"));
    url.searchParams.delete("sslmode");

    const maxLifetimeMs = this.poolConfig?.maxLifetimeMs;
    const pool = new Pool({
      connectionString: url.toString(),
      ssl,
      min: this.poolConfig?.min ?? 1,
      max: this.poolConfig?.max ?? 10,
      idleTimeoutMillis: this.poolConfig?.idleTimeoutMs,
      connectionTimeoutMillis: this.poolConfig?.connectionTimeoutMs,
      maxLifetimeSeconds: maxLifetimeMs !== undefined ? maxLifetimeMs / 1000 : undefined,
    });
    handleDisconnects(pool, ctx.log);

    // The listener opens its own client from the same configuration — one
    // `access` on the manifest, both halves behind it.
    this.#opened = { pool, listenerConfig: { connectionString: url.toString(), ssl } };
    return this.#opened;
  }

  /**
   * Subscribe to a `NOTIFY` channel; returns the unsubscribe.
   *
   * Postgres-only, so it lives HERE rather than on `Sql.Connection` — that
   * contract is what every backend implements, and a method only one of them can
   * answer would be a contract satisfied by throwing. A consumer reaches it the
   * way `Ai.Model`'s `invoke` / `stream` and a connection's own `query()` are
   * already reached: structurally, testing for the method rather than for a
   * nominal type.
   *
   * The listener is built on first use, because a subscription is the only
   * reason to hold a second connection open and most applications never take
   * one.
   */
  async listen(channel: string, onNotify: NotificationHandler): Promise<() => Promise<void>> {
    if (!this.#listener) {
      // Registered at the moment it is created, not reserved as a slot in
      // `init()`: an inverse pairs with a forward action that HAPPENED, and an
      // inverse waiting for a field to be filled later is a placeholder, not a
      // pair. Performed rather than returned, because this is reached from
      // ordinary method calls — it lands on the connection's own frame and
      // closes when the connection unwinds.
      const listener = new NotificationListener(this.#requireOpened().listenerConfig, this.ctx.log);
      await this.ctx
        .effect("notification listener", async () => {
          this.#listener = listener;
          return { result: listener, inverse: () => listener.close() };
        })
        .perform();
    }
    return this.#listener!.listen(channel, onNotify);
  }

  /** Send a notification. A no-op statement away from `execute`, named here so a
   *  caller does not have to know the function's name to use the channel it
   *  already subscribed to. */
  async notify(channel: string, payload?: string): Promise<void> {
    await this.execute("SELECT pg_notify($1, $2)", [channel, payload ?? ""]);
  }

  /**
   * The base's pool, then what the server is, then the liveness sweep on top — so
   * unwinding stops the sweep before destroying the pool it probes, without either
   * half stating that order. The sweep starts only once the connection has proved
   * itself: a recurring probe is a side effect, and starting it in `create()` would
   * leave a timer nobody owns. (The notification listener registers its own effect
   * when `listen()` first builds it.)
   *
   * The server's version and available extensions are reported before `init()`
   * returns, over the pool the base just proved; the kernel compares them with the
   * need, and a mismatch fails this `init()`, which destroys the pool.
   */
  override init(ctx: ResourceContext) {
    const { pool } = this.#open(ctx);
    return super
      .init(ctx)
      .effect("server observation", async () => {
        const result = await this.db.executeQuery<{ versionNum: string; extensions: string[] }>(
          CompiledQuery.raw(
            "SELECT current_setting('server_version_num') AS \"versionNum\", " +
              "ARRAY(SELECT name::text FROM pg_available_extensions WHERE name = ANY($1)) AS extensions",
            [Object.values(FEATURE_EXTENSIONS)],
          ),
        );
        const [row] = result.rows;
        ctx.verifyNeed(ACCESS, {
          version: serverVersionText(Number(row!.versionNum)),
          features: featuresOf(row!.extensions),
        });
        return { result: undefined };
      })
      .effect("health check", async () => ({
        result: undefined,
        inverse: startHealthCheck(
          pool,
          // `pool` present but `healthCheckMs` omitted takes the schema default;
          // `pool` omitted entirely never reaches AJV's property defaults, so the
          // fallback has to exist here too.
          this.poolConfig?.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS,
          this.poolConfig?.min ?? 1,
          ctx.log,
        ),
      }));
  }
}

export function register(): void {}

export async function create(
  resource: PostgresConnectionManifest,
  ctx: ResourceContext,
): Promise<PostgresConnection> {
  return new PostgresConnection(poolConfigOf(resource), ctx);
}
