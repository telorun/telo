import type { Logger, ResourceContext } from "@telorun/sdk";
import { quoteAnsiIdentifier, SqlConnectionBase, type SqlDialect } from "@telorun/sql";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

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
  connectionString: string;
  pool?: PoolConfig;
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

const postgresDialect: SqlDialect = {
  placeholderStyle: "numbered",
  quoteIdentifier: quoteAnsiIdentifier,
  // PostgreSQL binds the whole set as one array parameter, which keeps the
  // statement text stable regardless of how many elements are matched.
  renderIn(column, values, addParam) {
    return `${column} = ANY(${addParam(values)})`;
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

class PostgresConnection extends SqlConnectionBase {
  private stopHealthCheck: () => void = () => {};

  constructor(
    db: Kysely<any>,
    private readonly beginHealthCheck: () => () => void,
    ctx: ResourceContext,
  ) {
    super(db, postgresDialect, ctx);
  }

  /** The sweep starts only once the connection has proved itself: a recurring
   *  probe is a side effect, and an `init()` that throws is never torn down, so
   *  starting it in `create()` would leave a timer nobody owns. */
  override async init(): Promise<void> {
    await super.init();
    this.stopHealthCheck = this.beginHealthCheck();
  }

  override async teardown(): Promise<void> {
    this.stopHealthCheck();
    await super.teardown();
  }
}

export function register(): void {}

export async function create(
  resource: PostgresConnectionManifest,
  ctx: ResourceContext,
): Promise<PostgresConnection> {
  if (!resource.connectionString) {
    throw new Error("Postgres.Connection requires a connectionString");
  }
  const url = new URL(resource.connectionString);
  const ssl = sslFromSslmode(url.searchParams.get("sslmode"));
  url.searchParams.delete("sslmode");

  const maxLifetimeMs = resource.pool?.maxLifetimeMs;
  const minConnections = resource.pool?.min ?? 1;
  const pool = new Pool({
    connectionString: url.toString(),
    ssl,
    min: minConnections,
    max: resource.pool?.max ?? 10,
    idleTimeoutMillis: resource.pool?.idleTimeoutMs,
    connectionTimeoutMillis: resource.pool?.connectionTimeoutMs,
    maxLifetimeSeconds: maxLifetimeMs !== undefined ? maxLifetimeMs / 1000 : undefined,
  });

  handleDisconnects(pool, ctx.log);

  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });

  return new PostgresConnection(
    db,
    () =>
      startHealthCheck(
        pool,
        // `pool` present but `healthCheckMs` omitted takes the schema default;
        // `pool` omitted entirely never reaches AJV's property defaults, so the
        // fallback has to exist here too.
        resource.pool?.healthCheckMs ?? DEFAULT_HEALTH_CHECK_MS,
        minConnections,
        ctx.log,
      ),
    ctx,
  );
}
