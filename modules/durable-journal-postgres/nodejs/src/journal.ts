/**
 * A durable journal in two PostgreSQL tables — runs, and the entries under them.
 *
 * **What this store exists to answer, and the file journal cannot.** A directory
 * of files can record and read back; what it cannot do is settle a race between
 * two processes reaching for the same run, and it says so rather than pretending
 * with a lock file. Here both hard operations are the database's own: claiming
 * is one conditional `UPDATE`, so two resumers cannot both take a run whatever
 * the interleaving, and waking is `LISTEN`/`NOTIFY`, so a delivery reaches a
 * poller in milliseconds rather than at the next interval.
 *
 * **First writer wins is `ON CONFLICT DO NOTHING`, exactly.** The entry key is
 * the primary key `(run, path)`, so a duplicate append is refused by the
 * database and the stored row is returned instead — the property the file
 * journal can only approximate within one process, and the reason a caller must
 * use the returned entry rather than assume its own was kept.
 *
 * **It can share a transaction with the writes it records**, which is what makes
 * exactly-once reachable here. When a step's own statements run inside an
 * `Sql.Transaction` opened on this same connection, this journal's `INSERT`
 * lands inside it too — so a rollback discards the record along with the effect
 * it described, and the step engine stops collapsing that region. That is what
 * {@link PostgresJournalController.writesInside} attests, per connection and per
 * zone rather than as a blanket claim.
 */
import {
  decodeJsonValue,
  encodeJsonValue,
  InvokeError,
  type ResourceContext,
  type ResourceInstance,
  type ResourceManifest,
  type ZoneEntry,
} from "@telorun/sdk";
import { isSqlConnection, type SqlConnection } from "@telorun/sql";

interface JournalManifest extends ResourceManifest {
  connection: ResourceInstance;
  table?: string;
  createTable?: boolean;
  notifyChannel?: string;
}

interface JournalEntry {
  path: string;
  kind: "step" | "decision";
  decision?: string;
  target?: { kind: string; name: string; module?: string };
  value: unknown;
}

interface ParkRecord {
  path: string;
  resource: string;
  at?: number;
  token?: string;
}

type RunStatus = "scheduled" | "running" | "parked" | "completed" | "failed" | "cancelled";

interface RunRecord {
  run: string;
  status: RunStatus;
  dueAt?: number;
  parked?: ParkRecord;
  inputs?: unknown;
  result?: unknown;
  error?: { code: string; message: string };
  collapsedRegions?: number;
  collapseReasons?: string[];
}

/** The `LISTEN`/`NOTIFY` half, which only PostgreSQL answers — declared
 *  structurally, the way this repo's other cross-module capabilities are
 *  (`Ai.Model`'s `invoke`, a connection's `query`). A connection without it is
 *  usable; it simply cannot wake a poller, which the resumer's interval already
 *  covers. */
interface NotifyingConnection extends SqlConnection {
  listen(channel: string, onNotify: (payload: string | undefined) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload?: string): Promise<void>;
}

function canNotify(connection: SqlConnection): connection is NotifyingConnection {
  const candidate = connection as Partial<NotifyingConnection>;
  return typeof candidate.listen === "function" && typeof candidate.notify === "function";
}

interface RunRow {
  run: string;
  status: RunStatus;
  due_at: string | number | null;
  parked_path: string | null;
  parked_resource: string | null;
  parked_token: string | null;
  inputs: string | null;
  result: string | null;
  error: string | null;
  collapsed_regions: number | null;
  collapse_reasons: string | null;
}

interface EntryRow {
  path: string;
  entry_kind: "step" | "decision";
  decision: string | null;
  target: string | null;
  value: string | null;
}

/** `BIGINT` arrives from `pg` as a STRING, because a 64-bit integer does not fit
 *  a JS number — so every epoch-millisecond column passes through here rather
 *  than being read as a number that silently is not one. */
function millis(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  return typeof value === "number" ? value : Number(value);
}

function decodeOptional(value: string | null): unknown {
  return value === null ? undefined : decodeJsonValue(value);
}

function encodeOptional(value: unknown): string | null {
  return value === undefined ? null : encodeJsonValue(value);
}

/**
 * The three SQLSTATEs that mean "someone else created it first".
 *
 * `42P07` duplicate_table and `42710` duplicate_object are the direct forms;
 * `23505` is the one that actually shows up under a race, because the loser gets
 * as far as inserting into `pg_type` / `pg_class` and trips their unique index
 * rather than the DDL's own check.
 */
const DUPLICATE_OBJECT_SQLSTATES = new Set(["42P07", "42710", "23505"]);

function isDuplicateObject(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  // The driver's error may arrive wrapped by kysely, so the cause chain is
  // walked rather than only the top frame — a bounded walk, since a cycle in a
  // cause chain would otherwise hang a boot.
  if (typeof code === "string" && DUPLICATE_OBJECT_SQLSTATES.has(code)) return true;
  let cause = (err as { cause?: unknown })?.cause;
  for (let depth = 0; cause && depth < 8; depth++) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" && DUPLICATE_OBJECT_SQLSTATES.has(causeCode)) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/** A table name reaches SQL as an IDENTIFIER, where no placeholder exists — so
 *  it is validated at construction rather than bound, and the check is a
 *  whitelist because anything looser is a way to write arbitrary SQL from a
 *  manifest field. */
function validateTableName(name: string, describe: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `${describe}: table prefix '${name}' is not a plain SQL identifier — ` +
        `use letters, digits and underscores, starting with a letter or underscore`,
    );
  }
  return name;
}

function rowToRecord(row: RunRow): RunRecord {
  const park: ParkRecord | undefined =
    row.parked_path === null
      ? undefined
      : {
          path: row.parked_path,
          resource: row.parked_resource ?? "",
          ...(millis(row.due_at) === undefined ? {} : { at: millis(row.due_at) }),
          ...(row.parked_token === null ? {} : { token: row.parked_token }),
        };
  const dueAt = millis(row.due_at);
  return {
    run: row.run,
    status: row.status,
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(park === undefined ? {} : { parked: park }),
    ...(row.inputs === null ? {} : { inputs: decodeJsonValue(row.inputs) }),
    ...(row.result === null ? {} : { result: decodeJsonValue(row.result) }),
    ...(row.error === null ? {} : { error: decodeJsonValue(row.error) as RunRecord["error"] }),
    ...(row.collapsed_regions === null ? {} : { collapsedRegions: row.collapsed_regions }),
    ...(row.collapse_reasons === null
      ? {}
      : { collapseReasons: decodeJsonValue(row.collapse_reasons) as string[] }),
  };
}

function rowToEntry(row: EntryRow): JournalEntry {
  return {
    path: row.path,
    kind: row.entry_kind,
    ...(row.decision === null ? {} : { decision: row.decision }),
    ...(row.target === null
      ? {}
      : { target: decodeJsonValue(row.target) as JournalEntry["target"] }),
    value: decodeOptional(row.value),
  };
}

class PostgresJournalController {
  readonly #describe: string;
  readonly #runs: string;
  readonly #entries: string;
  readonly #channel: string;
  #connection: SqlConnection | undefined;
  #ready: Promise<void> | undefined;
  #createTables = true;
  /** Subscribers to this journal's wake channel — the resumer, in practice. */
  readonly #wakeHandlers = new Set<(run: string) => void>();
  #unlisten: (() => Promise<void>) | undefined;

  constructor(
    private readonly resource: JournalManifest,
    private readonly ctx: ResourceContext,
  ) {
    this.#describe = `DurableJournalPostgres.Journal "${resource.metadata.name}"`;
    const prefix = validateTableName(resource.table ?? "telo_durable", this.#describe);
    this.#runs = `"${prefix}_runs"`;
    this.#entries = `"${prefix}_entries"`;
    this.#channel = resource.notifyChannel ?? `${prefix}_wake`;
  }

  /**
   * Run a statement outside whatever transaction the caller has open.
   *
   * The default path is the opposite, and deliberately so: a statement with no
   * zone joins the ambient transaction on this connection, which is the whole
   * mechanism behind exactly-once — a step's record commits and rolls back with
   * the effect it describes.
   *
   * That is right for {@link append} and wrong for everything else. A run's
   * LIFECYCLE is not part of the work: a settlement discarded by someone's
   * rollback leaves a run recorded as still executing while its effects are
   * gone, a park erased the same way strands work with no wake, and a claim that
   * rolls back releases a run another poller may already have taken. Those
   * records describe the run itself, so they must survive whatever the run was
   * doing.
   */
  private executeOutsideTransaction<T>(sql: string, params: unknown[] = []) {
    return this.conn().executeUncommitted<T>(sql, params);
  }

  private conn(): SqlConnection {
    this.#connection ??= this.ctx.resolveRef(
      this.resource.connection,
      isSqlConnection,
      () => `${this.#describe}: 'connection'`,
      "Postgres.Connection",
    );
    return this.#connection;
  }

  /**
   * Ensuring the tables exist allocates nothing this journal owns — `IF NOT
   * EXISTS` throughout, and the tables outlive every process — so this step has
   * no inverse to state. The wake subscription DOES allocate, and registers its
   * own effect at the moment `onWake` opens it.
   */
  init(ctx: ResourceContext) {
    return ctx.effect("journal tables", async () => {
      this.#createTables = this.resource.createTable !== false;
      await this.ready();
      return { result: undefined };
    });
  }

  /**
   * The tables exist, or are being created — awaited by every operation.
   *
   * Established here rather than only in `init()`, and that is not defensive
   * padding: `await undefined` resolves, so a `#ready` that is only assigned in
   * `init()` makes every method called before it a silent no-op wait against
   * tables that may not exist. Resources init in dependency order, and a journal
   * read from another resource's `init()` is exactly the case that ordering does
   * not always cover.
   */
  private ready(): Promise<void> {
    // `IF NOT EXISTS` throughout: several application instances boot against one
    // database at once, and a create that raced would fail a boot for a table
    // that exists.
    this.#ready ??= this.#createTables ? this.createTables() : Promise.resolve();
    return this.#ready;
  }

  private async createTables(): Promise<void> {
    await this.createIfAbsent(
      `CREATE TABLE IF NOT EXISTS ${this.#runs} (
         run TEXT PRIMARY KEY,
         status TEXT NOT NULL,
         due_at BIGINT,
         parked_path TEXT,
         parked_resource TEXT,
         parked_token TEXT,
         inputs TEXT,
         result TEXT,
         error TEXT,
         collapsed_regions INTEGER,
         collapse_reasons TEXT,
         claim_holder TEXT,
         claim_until BIGINT
       )`,
    );
    await this.createIfAbsent(
      `CREATE TABLE IF NOT EXISTS ${this.#entries} (
         run TEXT NOT NULL,
         path TEXT NOT NULL,
         seq BIGSERIAL,
         entry_kind TEXT NOT NULL,
         decision TEXT,
         target TEXT,
         value TEXT,
         PRIMARY KEY (run, path)
       )`,
    );
    // Write ORDER is a column, not the primary key: entries are keyed by path
    // because that is what makes a duplicate append refusable, and `readEntries`
    // must still return them in the order they were written.
    await this.createIfAbsent(
      `CREATE INDEX IF NOT EXISTS ${this.indexName("entries_seq")} ON ${this.#entries} (run, seq)`,
    );
    // A delivery looks a run up BY TOKEN, which is the operation a directory of
    // files answers with a full scan. Here it is an index.
    await this.createIfAbsent(
      `CREATE INDEX IF NOT EXISTS ${this.indexName("parked_token")} ` +
        `ON ${this.#runs} (parked_token) WHERE parked_token IS NOT NULL`,
    );
    await this.createIfAbsent(
      `CREATE INDEX IF NOT EXISTS ${this.indexName("due")} ON ${this.#runs} (status, due_at)`,
    );
  }

  /**
   * Create one object, tolerating another process creating it at the same moment.
   *
   * **`IF NOT EXISTS` is not race-safe, and believing it was is the defect.**
   * Postgres checks for the object and then creates it, so two connections
   * arriving together both pass the check and the loser fails on the catalogue's
   * own unique index — `duplicate key value violates unique constraint
   * "pg_type_typname_nsp_index"`, which reads like corruption and is nothing of
   * the kind. That is precisely the case this journal claims to support: several
   * application instances booting against one database at once.
   *
   * A duplicate-object error IS the object existing, which is the outcome the
   * statement asked for, so treating those three SQLSTATEs as success is not
   * swallowing a failure — it is reading the one the server sent. Every other
   * error propagates: a missing grant, an unreachable server and a syntax error
   * must still fail the boot, loudly.
   */
  private async createIfAbsent(sql: string): Promise<void> {
    try {
      await this.conn().execute(sql);
    } catch (err) {
      if (!isDuplicateObject(err)) throw err;
      this.ctx.log.debug("schema object created concurrently by another instance", {
        "db.query.text": sql,
      });
    }
  }

  private indexName(suffix: string): string {
    return `"${this.#runs.slice(1, -1)}_${suffix}_idx"`;
  }

  async provide(): Promise<this> {
    return this;
  }

  async admitRun(
    run: string,
    init?: { status?: "running" | "scheduled"; dueAt?: number; inputs?: unknown },
  ): Promise<{ admitted: boolean; existing?: RunRecord }> {
    await this.ready();
    // One statement is the whole admission: an insert that conflicts reports
    // that the run already exists. Reading first and then inserting would leave
    // a window between the two, and that window is exactly where a concurrent
    // duplicate start slips through — which on this store, unlike the file one,
    // there is no excuse for.
    const inserted = await this.executeOutsideTransaction<{ run: string }>(
      `INSERT INTO ${this.#runs} (run, status, due_at, inputs)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run) DO NOTHING
       RETURNING run`,
      [run, init?.status ?? "running", init?.dueAt ?? null, encodeOptional(init?.inputs)],
    );
    if (inserted.rows.length > 0) return { admitted: true };
    const existing = await this.readRun(run);
    return {
      admitted: false,
      ...(existing === undefined ? {} : { existing }),
    };
  }

  async readRun(run: string): Promise<RunRecord | undefined> {
    await this.ready();
    const result = await this.conn().execute<RunRow>(
      `SELECT run, status, due_at, parked_path, parked_resource, parked_token,
              inputs, result, error, collapsed_regions, collapse_reasons
         FROM ${this.#runs} WHERE run = $1`,
      [run],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async readEntries(run: string): Promise<JournalEntry[]> {
    await this.ready();
    const result = await this.conn().execute<EntryRow>(
      `SELECT path, entry_kind, decision, target, value
         FROM ${this.#entries} WHERE run = $1 ORDER BY seq`,
      [run],
    );
    return result.rows.map(rowToEntry);
  }

  /**
   * Append one entry, FIRST WRITER WINS.
   *
   * The ONE operation that deliberately joins the caller's transaction (see
   * {@link executeOutsideTransaction} for why every other write does not): a
   * step's record belongs with the effect it describes, so a rollback must
   * discard both. That is the whole of exactly-once, and it is why this journal
   * being on the same connection as the work is a correctness property rather
   * than a deployment convenience.
   *
   * Reads join too, for the same reason read the other way: a replay inside that
   * transaction must see the entries written inside it.
   */
  async append(run: string, entry: JournalEntry): Promise<JournalEntry> {
    await this.ready();
    const conn = this.conn();
    const inserted = await conn.execute<EntryRow>(
      `INSERT INTO ${this.#entries} (run, path, entry_kind, decision, target, value)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run, path) DO NOTHING
       RETURNING path, entry_kind, decision, target, value`,
      [
        run,
        entry.path,
        entry.kind,
        entry.decision ?? null,
        entry.target === undefined ? null : encodeJsonValue(entry.target),
        encodeOptional(entry.value),
      ],
    );
    if (inserted.rows.length > 0) return rowToEntry(inserted.rows[0]!);
    // Lost the race, so the stored entry is the answer — returned rather than
    // signalled, because the caller must REPLAY against what was recorded and
    // not against what it just computed.
    const stored = await conn.execute<EntryRow>(
      `SELECT path, entry_kind, decision, target, value
         FROM ${this.#entries} WHERE run = $1 AND path = $2`,
      [run, entry.path],
    );
    const row = stored.rows[0];
    if (!row) {
      throw new InvokeError(
        "ERR_DURABLE_JOURNAL_CORRUPT",
        `Run '${run}': the entry at '${entry.path}' was refused as a duplicate and then ` +
          `could not be read back. Something outside this journal is deleting its rows.`,
        { run },
      );
    }
    return rowToEntry(row);
  }

  async completeRun(run: string, outcome: Omit<RunRecord, "run">): Promise<void> {
    await this.ready();
    // The park is cleared as part of settling: a completed run that kept its
    // park columns would be returned by `runParkedOn` forever, handing a
    // delivery a run that is not waiting for it.
    await this.executeOutsideTransaction(
      `UPDATE ${this.#runs}
          SET status = $2, result = $3, error = $4,
              collapsed_regions = $5, collapse_reasons = $6,
              due_at = NULL, parked_path = NULL, parked_resource = NULL, parked_token = NULL,
              claim_holder = NULL, claim_until = NULL
        WHERE run = $1`,
      [
        run,
        outcome.status,
        encodeOptional(outcome.result),
        encodeOptional(outcome.error),
        outcome.collapsedRegions ?? null,
        outcome.collapseReasons === undefined ? null : encodeJsonValue(outcome.collapseReasons),
      ],
    );
  }

  async parkRun(run: string, park: ParkRecord): Promise<void> {
    await this.ready();
    // The claim goes with the park: the run is no longer being worked on, and
    // holding it would make the parked run invisible to every poller — including
    // this process's own, after a delivery — until the TTL lapsed.
    await this.executeOutsideTransaction(
      `UPDATE ${this.#runs}
          SET status = 'parked', parked_path = $2, parked_resource = $3, parked_token = $4,
              due_at = $5, claim_holder = NULL, claim_until = NULL
        WHERE run = $1`,
      [run, park.path, park.resource, park.token ?? null, park.at ?? null],
    );
  }

  async unparkRun(run: string): Promise<void> {
    await this.ready();
    const result = await this.executeOutsideTransaction(
      `UPDATE ${this.#runs}
          SET status = 'running', parked_path = NULL, parked_resource = NULL,
              parked_token = NULL, due_at = NULL
        WHERE run = $1 AND status = 'parked'`,
      [run],
    );
    // Waking is what a NOTIFY is FOR: a run that just became runnable should be
    // picked up now rather than at the next poll. Best-effort by construction —
    // the resumer's interval is the guarantee, and this only makes it prompt.
    if (this.conn().toRowCount(result) > 0) await this.wake(run);
  }

  async runParkedOn(token: string): Promise<{ run: string; park: ParkRecord } | undefined> {
    await this.ready();
    const result = await this.conn().execute<RunRow>(
      `SELECT run, status, due_at, parked_path, parked_resource, parked_token,
              inputs, result, error, collapsed_regions, collapse_reasons
         FROM ${this.#runs} WHERE parked_token = $1 AND status = 'parked'`,
      [token],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const record = rowToRecord(row);
    return record.parked ? { run: record.run, park: record.parked } : undefined;
  }

  /**
   * What a poller should work on now.
   *
   * `FOR UPDATE SKIP LOCKED` is here so two resumers sweeping at the same moment
   * step over each other's rows instead of returning one list twice — but it is
   * NOT what makes claiming safe, and saying so matters: this statement runs
   * outside a transaction, so its row locks end with it. The guarantee is
   * {@link claimRun}'s conditional `UPDATE`, which is atomic on its own. The
   * skip is what stops two pollers wasting a round trip each on the same run.
   */
  async dueRuns(now: number, limit: number): Promise<string[]> {
    await this.ready();
    const result = await this.conn().execute<{ run: string }>(
      `SELECT run FROM ${this.#runs} r
        WHERE (r.claim_until IS NULL OR r.claim_until <= $1)
          AND (
            r.status = 'running'
            OR (r.status = 'scheduled' AND r.due_at IS NOT NULL AND r.due_at <= $1)
            OR (r.status = 'parked' AND (
                 (r.due_at IS NOT NULL AND r.due_at <= $1)
                 -- The answer ALREADY BEING RECORDED outranks the deadline. A
                 -- delivery writes the payload and then clears the park; a crash
                 -- in between would otherwise strand a run that holds its answer
                 -- and has no deadline to wake it. The entry is the fact that
                 -- matters, so reading it closes that window with no atomicity
                 -- needed.
                 OR EXISTS (SELECT 1 FROM ${this.#entries} e
                             WHERE e.run = r.run AND e.path = r.parked_path)
               ))
          )
        ORDER BY r.due_at NULLS FIRST
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return result.rows.map((row) => row.run);
  }

  /**
   * Take exclusive ownership of a run.
   *
   * One conditional `UPDATE`, which is the whole point of putting a journal in a
   * database: the row is claimable when nobody holds it, when the holder's lease
   * has lapsed, or when the caller already holds it, and the database settles
   * every interleaving of that. A read followed by a write would reopen exactly
   * the race the file journal cannot close.
   */
  async claimRun(run: string, holder: string, ttlMs: number): Promise<boolean> {
    await this.ready();
    const now = Date.now();
    const conn = this.conn();
    const result = await this.executeOutsideTransaction(
      `UPDATE ${this.#runs}
          SET claim_holder = $2, claim_until = $3
        WHERE run = $1
          AND (claim_until IS NULL OR claim_until <= $4 OR claim_holder = $2)`,
      [run, holder, now + ttlMs, now],
    );
    return conn.toRowCount(result) > 0;
  }

  /**
   * Do this journal's writes land inside the given zone's atomicity?
   *
   * Yes exactly when the connection this journal writes through is the one
   * holding that zone's open transaction — asked of the NAMED zone rather than
   * of whatever is ambient, because a blanket "there is a transaction somewhere"
   * would attest membership of a region the entries may not be in. When it is
   * true the step engine journals the region per step instead of collapsing it,
   * and a rollback discards the record with the effect it described. When the
   * journal points at a different database, it is false and today's collapse
   * applies — correctly.
   */
  writesInside(zone: ZoneEntry): boolean {
    return this.conn().bindsZone(zone);
  }

  /**
   * Be told when a run becomes runnable, so a poller wakes on the delivery
   * rather than on its interval.
   *
   * Returns a no-op unsubscribe on a connection that cannot `LISTEN`. A journal
   * whose wake never arrives is slower, never wrong — the poll is the
   * correctness path — so degrading here is honest rather than a swallowed
   * failure.
   */
  async onWake(handler: (run: string) => void): Promise<() => Promise<void>> {
    const conn = this.conn();
    if (!canNotify(conn)) {
      this.ctx.log.debug(
        "durable journal wake unavailable; the connection does not support LISTEN/NOTIFY",
      );
      return async () => {};
    }
    this.#wakeHandlers.add(handler);
    if (!this.#unlisten) {
      // Registered at the moment the subscription is OPENED, on the journal's
      // own frame — an inverse pairs with a forward action that happened, so a
      // slot reserved in `init()` for a subscription nobody may ever open is a
      // placeholder rather than a pair. It closes if the journal unwinds while
      // subscribers are still attached; the unsubscribe below is the ordinary
      // path, and disposing twice is a no-op.
      const { result } = await this.ctx
        .effect("wake subscription", async () => {
          const unlisten = await conn.listen(this.#channel, (payload) => {
            for (const subscriber of this.#wakeHandlers) subscriber(payload ?? "");
          });
          this.#unlisten = unlisten;
          return { result: unlisten, inverse: () => this.closeWakeSubscription() };
        })
        .perform();
      void result;
    }
    return async () => {
      this.#wakeHandlers.delete(handler);
      if (this.#wakeHandlers.size > 0) return;
      await this.closeWakeSubscription();
    };
  }

  /** Drop the subscription, whether the last subscriber left or the journal
   *  itself is unwinding. Idempotent — both paths reach it. */
  private async closeWakeSubscription(): Promise<void> {
    const unlisten = this.#unlisten;
    this.#unlisten = undefined;
    await unlisten?.();
  }

  private async wake(run: string): Promise<void> {
    const conn = this.conn();
    if (!canNotify(conn)) return;
    try {
      await conn.notify(this.#channel, run);
    } catch (err) {
      this.ctx.log.debug("durable journal wake notification failed", undefined, { error: err });
    }
  }

  snapshot(): Record<string, unknown> {
    return { table: this.#runs.slice(1, -1), channel: this.#channel };
  }
}

export function register(): void {}

export async function create(
  resource: JournalManifest,
  ctx: ResourceContext,
): Promise<PostgresJournalController> {
  return new PostgresJournalController(resource, ctx);
}
