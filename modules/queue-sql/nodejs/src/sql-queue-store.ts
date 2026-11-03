import { randomBytes } from "node:crypto";
import {
  InvokeError,
  celDurationFromNanos,
  celTimestamp,
  celTimestampFromMillis,
  durationNanos,
  isCelDuration,
  isCelTimestamp,
  NEVER_CANCELLED,
  timestampNanos,
  type CelDuration,
  type CelTimestamp,
  type InvokeContext,
  type ResourceContext,
  type ResourceInstance,
  type ZoneEntry,
} from "@telorun/sdk";
import {
  readInt64Column,
  readTimestampColumn,
  SqlFragments,
  type SqlConnection,
  type SqlInstantArithmeticSchema,
  type SqlLockSchema,
} from "@telorun/sql";
import type {
  AddressableQueueStore,
  CancelOutcome,
  ClaimedMessage,
  ClaimOutcome,
  ClaimRequest,
  EnqueueOutcome,
  EnqueueRequest,
  ListOutcome,
  ListRequest,
  MessageState,
  QueueError,
  QueueSettings,
  QueueStats,
  ReleaseRequest,
  RenewOutcome,
  RequeueOutcome,
  SettleOutcome,
  StoredMessageAbsent,
  StoredMessageFound,
} from "@telorun/queue";
import { pinnedZone } from "./enqueue-zone.js";
import { groupKeyOf, type GroupBy } from "./group-key.js";
import { claimQueueName } from "./queue-name-claims.js";
import { queueColumns, type DeclaredTableHolder, type QueueColumns } from "./queue-table.js";
import { canNotify, QueueWake } from "./queue-wake.js";
import { decodeStoredError, encodeStoredError, STORED_ERROR_GENERATION } from "./stored-error.js";

export type QueueSchema = SqlInstantArithmeticSchema & SqlLockSchema;

/** Settled rows past retention one claim removes at most. */
const PURGE_BATCH = 100;
/** Lapsed cancel-requested rows one claim settles at most. */
const LAPSED_CANCEL_BATCH = 100;
/** How long one claim on a queue that can be woken waits for work before it
 *  answers empty; the worker's own poll covers a wake that never arrives. */
const CLAIM_WAIT_MS = 5_000;
/** Passes an enqueue makes over items whose row vanished between its insert and
 *  its read-back (a concurrent purge of an expired row). */
const ENQUEUE_PASSES = 2;

const NANOS_PER_MILLI = 1_000_000n;

const ERR_QUEUE_GROUP_INVALID = "ERR_QUEUE_GROUP_INVALID";
const ERR_QUEUE_STORE_INCONSISTENT = "ERR_QUEUE_STORE_INCONSISTENT";

/** Settled states a message expires from once `retention` has passed. */
const EXPIRING = "('completed', 'cancelled')";
/** States that keep a message unsettled, and so hold its group. */
const UNSETTLED = "('pending', 'running', 'dead')";

interface ClaimRow {
  seq: unknown;
  message_id: string;
  state: string;
  body: string;
  envelope_generation: unknown;
  enqueued_at: unknown;
  dying_error: unknown;
  error_generation: unknown;
  traceparent: string | null;
  tracestate: string | null;
}

interface MessageRow {
  seq: unknown;
  message_id: string;
  shown_state: string;
  attempts: unknown;
  enqueued_at: unknown;
  visible_at: unknown;
  settled_at: unknown;
  last_error: unknown;
  error_generation: unknown;
  cancel_reason: string | null;
  body: string;
  envelope_generation: unknown;
}

/**
 * One named queue in a table of the application's own database — the store the
 * queue operations call (the contract: `modules/queue/docs/store-contract.md`).
 *
 * Engine-neutral: every statement names its table through the engine Schema
 * instance, every instant through its instant members and every concurrent row
 * selection through its lock-skipping clause, so nothing here names an engine.
 * Every instant is the database's clock; the host clock only waits.
 */
export class SqlQueueStore implements AddressableQueueStore, ResourceInstance {
  private readonly table: string;
  private readonly c: QueueColumns;
  private readonly expiryShift: CelDuration;
  private readonly wake: QueueWake | undefined;

  constructor(
    readonly describe: string,
    private readonly ctx: ResourceContext,
    private readonly connection: SqlConnection,
    private readonly schema: QueueSchema,
    private readonly tableResource: DeclaredTableHolder,
    readonly name: string,
    retention: CelDuration,
    private readonly groupBy: GroupBy | undefined,
    private readonly queueSettings: QueueSettings,
  ) {
    const declaration = tableResource.declaration;
    this.c = queueColumns(describe, declaration, connection.dialect);
    this.table = schema.qualifiedTableName(declaration);
    const shift = celDurationFromNanos(-durationNanos(retention));
    if (!isCelDuration(shift)) {
      throw new Error(`${describe}: 'retention' is outside the range a duration can be negated in.`);
    }
    this.expiryShift = shift;
    this.wake = canNotify(connection) ? new QueueWake(connection, ctx, this.table, name) : undefined;
  }

  init(ctx: ResourceContext) {
    return ctx.effect("queue name claim", async () => ({
      result: undefined,
      inverse: claimQueueName(
        this.tableResource,
        this.tableResource.declaration.name,
        this.name,
        this,
        this.describe,
      ),
    }));
  }

  snapshot(): Record<string, unknown> {
    return { name: this.name };
  }

  settings(): QueueSettings {
    return this.queueSettings;
  }

  // ---------------------------------------------------------------- enqueue

  /**
   * Stores a batch. Inside a transaction open on this queue's connection — the
   * zone `QueueSql.Enqueue` pinned, else the innermost one this connection holds
   * — the messages commit or roll back with it; otherwise they are stored in a
   * transaction of their own.
   */
  async enqueue(items: readonly EnqueueRequest[], ctx?: InvokeContext): Promise<EnqueueOutcome[]> {
    if (items.length === 0) return [];
    // Every group is read before anything is written, so a refused item leaves
    // the whole batch unstored.
    const groups = this.groupsOf(items);
    const zone = pinnedZone(ctx) ?? this.boundZone(ctx);
    if (zone) {
      const outcomes = await this.enqueueOn(zone, items, groups, ctx);
      // Sent on the transaction the caller has open, so the database delivers
      // it at commit and drops it at rollback.
      if (this.wake && outcomes.some((outcome) => outcome.status === "stored")) await this.wake.notify();
      return outcomes;
    }
    const own = this.ownZone();
    const outcomes = await this.connection.runInTransaction((bind) => {
      bind(own);
      return this.enqueueOn(own, items, groups, ctx);
    });
    if (outcomes.some((outcome) => outcome.status === "stored")) await this.wakeAfterCommit();
    return outcomes;
  }

  /** The innermost transaction zone in `ctx` that this connection holds. */
  private boundZone(ctx: InvokeContext | undefined): ZoneEntry | undefined {
    return this.ctx.zonesFor(this.connection, ctx).find((entry) => this.connection.bindsZone(entry));
  }

  /** Each item's group, or null on a queue that does not group. */
  private groupsOf(items: readonly EnqueueRequest[]): (string | null)[] {
    const groupBy = this.groupBy;
    if (!groupBy) return items.map(() => null);
    return items.map((item, index) => {
      const group = groupKeyOf(groupBy, item.body);
      if ("key" in group) return group.key;
      throw new InvokeError(
        ERR_QUEUE_GROUP_INVALID,
        `${this.describe}: message ${index} ('${item.id}') ${group.refused}, the member 'groupBy' ` +
          `names, so it has no group to be delivered in; nothing of the batch was stored.`,
        { index },
      );
    });
  }

  private async enqueueOn(
    zone: ZoneEntry,
    items: readonly EnqueueRequest[],
    groups: readonly (string | null)[],
    ctx: InvokeContext | undefined,
  ): Promise<EnqueueOutcome[]> {
    const outcomes: (EnqueueOutcome | undefined)[] = items.map(() => undefined);
    let open = items.map((_, index) => index);
    for (let pass = 0; pass < ENQUEUE_PASSES && open.length > 0; pass++) {
      // An id repeated inside one batch is inserted once; the later items
      // compare against what the first stored.
      const first = new Map<string, number>();
      for (const index of open) if (!first.has(items[index]!.id)) first.set(items[index]!.id, index);
      const ids = [...first.keys()];
      await this.removeExpired(ids, zone, ctx);
      const stored = await this.insert([...first.values()], items, groups, zone, ctx);
      for (const [id, index] of first) if (stored.has(id)) outcomes[index] = { status: "stored" };
      const unresolved = open.filter((index) => outcomes[index] === undefined);
      open = unresolved;
      if (open.length === 0) break;
      const digests = await this.storedDigests(
        [...new Set(unresolved.map((index) => items[index]!.id))],
        zone,
        ctx,
      );
      for (const index of unresolved) {
        const digest = digests.get(items[index]!.id);
        if (digest === undefined) continue;
        outcomes[index] = { status: digest === items[index]!.digest ? "duplicate" : "conflict" };
      }
      open = open.filter((index) => outcomes[index] === undefined);
    }
    if (open.length > 0) {
      throw new InvokeError(
        ERR_QUEUE_STORE_INCONSISTENT,
        `${this.describe}: message '${items[open[0]!]!.id}' was neither stored nor found in table ` +
          `'${this.tableResource.declaration.name}' — something outside this queue is changing its rows.`,
      );
    }
    return outcomes as EnqueueOutcome[];
  }

  /** An id whose message settled longer ago than retention is free: its row is
   *  removed here, in the enqueue's own transaction, before the insert. */
  private async removeExpired(ids: readonly string[], zone: ZoneEntry, ctx: InvokeContext | undefined) {
    const c = this.c;
    const statement = new SqlFragments()
      .text(`DELETE FROM ${this.table} WHERE ${c.queueName} = `)
      .value(this.name)
      .text(` AND ${c.messageId} IN (`)
      .valueList(ids, ", ")
      .text(`) AND `)
      .append(this.expired(""));
    await this.statement(statement, zone, ctx);
  }

  /** Inserts each item unless its id is taken; answers the ids it stored. */
  private async insert(
    indexes: readonly number[],
    items: readonly EnqueueRequest[],
    groups: readonly (string | null)[],
    zone: ZoneEntry,
    ctx: InvokeContext | undefined,
  ): Promise<Set<string>> {
    const c = this.c;
    const statement = new SqlFragments().text(
      `INSERT INTO ${this.table} (${c.queueName}, ${c.messageId}, ${c.groupKey}, ${c.state}, ` +
        `${c.body}, ${c.digest}, ${c.envelopeGeneration}, ${c.attempts}, ${c.enqueuedAt}, ` +
        `${c.visibleAt}, ${c.cancelRequested}, ${c.traceparent}, ${c.tracestate}) VALUES `,
    );
    indexes.forEach((at, index) => {
      const item = items[at]!;
      if (index > 0) statement.text(", ");
      statement
        .text("(")
        .value(this.name)
        .text(", ")
        .value(item.id)
        .text(", ")
        .value(groups[at]!)
        .text(", 'pending', ")
        .value(item.body)
        .text(", ")
        .value(item.digest)
        .text(", ")
        .value(item.generation)
        .text(`, 0, ${this.schema.currentInstant()}, `)
        .append(this.visibility(item.after))
        .text(", 0, ")
        .value(item.traceparent ?? null)
        .text(", ")
        .value(item.tracestate ?? null)
        .text(")");
    });
    statement.text(` ON CONFLICT (${c.queueName}, ${c.messageId}) DO NOTHING RETURNING ${c.messageId} AS message_id`);
    const result = await this.statement<{ message_id: string }>(statement, zone, ctx);
    return new Set(result.rows.map((row) => row.message_id));
  }

  private async storedDigests(
    ids: readonly string[],
    zone: ZoneEntry,
    ctx: InvokeContext | undefined,
  ): Promise<Map<string, string>> {
    const c = this.c;
    const statement = new SqlFragments()
      .text(`SELECT ${c.messageId} AS message_id, ${c.digest} AS digest FROM ${this.table} WHERE ${c.queueName} = `)
      .value(this.name)
      .text(` AND ${c.messageId} IN (`)
      .valueList(ids, ", ")
      .text(")");
    const result = await this.statement<{ message_id: string; digest: string }>(statement, zone, ctx);
    return new Map(result.rows.map((row) => [row.message_id, row.digest]));
  }

  /** When an enqueued message first becomes visible, rounded up to the
   *  millisecond so it is never visible before the time it was given. */
  private visibility(after: CelDuration | CelTimestamp | undefined): SqlFragments {
    if (after === undefined) return new SqlFragments().text(this.schema.currentInstant());
    if (isCelTimestamp(after)) return this.schema.instantParameter(ceilTimestampToMillis(after));
    return this.schema.currentInstantPlus(ceilDurationToMillis(after));
  }

  // ------------------------------------------------------------------ claim

  /**
   * Claims up to `limit` messages. On a queue that can be woken, an empty claim
   * waits — for a wake, for the next message to become visible, or for the
   * caller to cancel — and claims again, for at most {@link CLAIM_WAIT_MS} and
   * never longer than a sixth of the lease: the worker reckons a lease from the
   * moment it asked, and gives a message up when a third of the lease is left,
   * so a claim that waited longer would hand over messages already given up.
   * Otherwise it answers at once and the worker polls.
   */
  async claim(request: ClaimRequest, ctx?: InvokeContext): Promise<ClaimOutcome> {
    const cancellation = ctx?.cancellation ?? NEVER_CANCELLED;
    const wake = this.wake && (await this.wake.subscribe()) ? this.wake : undefined;
    const leaseMs = Number(durationNanos(request.lease) / NANOS_PER_MILLI);
    const deadline = Date.now() + Math.min(CLAIM_WAIT_MS, leaseMs / 6);
    for (;;) {
      const mark = wake?.mark() ?? 0;
      const messages = await this.claimOnce(request);
      if (messages.length > 0 || !wake || cancellation.isCancelled) return { messages };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { messages };
      const untilVisible = await this.msUntilNextVisible();
      await wake.wait(mark, Math.min(remaining, untilVisible ?? remaining), cancellation);
      if (cancellation.isCancelled) return { messages: [] };
    }
  }

  private async claimOnce(request: ClaimRequest): Promise<ClaimedMessage[]> {
    const token = randomBytes(16).toString("hex");
    const zone = this.ownZone();
    const claimed = await this.connection.runInTransaction(async (bind) => {
      bind(zone);
      // A write first, so an engine with one writer takes its write lock at the
      // start of the transaction rather than failing to upgrade a read.
      await this.purge(zone);
      await this.settleLapsedCancels(zone);
      const rows = await this.candidates(request.limit, zone);
      if (rows.length === 0) return [];
      const attempts = await this.markRunning(rows, token, request.lease, zone);
      return rows.map((row) => this.claimedOf(row, token, attempts));
    });
    return claimed;
  }

  /** The purge hook: settled messages past retention, in a bounded batch,
   *  passing over rows another transaction holds. Dead messages never expire.
   *  No order is asked for, so the batch is the first entries of the settle-time
   *  index range and costs its size, not the number of expired rows. */
  private async purge(zone: ZoneEntry): Promise<void> {
    const c = this.c;
    const statement = new SqlFragments()
      .text(`DELETE FROM ${this.table} WHERE ${c.seq} IN (SELECT ${c.seq} FROM ${this.table} WHERE ${c.queueName} = `)
      .value(this.name)
      .text(" AND ")
      .append(this.expired(""))
      .text(` LIMIT `)
      .value(PURGE_BATCH)
      .text(` ${this.schema.skipLockedClause()})`);
    await this.statement(statement, zone);
  }

  /** A running message whose cancel was requested and whose lease lapsed has no
   *  handler left to stop: it is settled `cancelled` rather than delivered. */
  private async settleLapsedCancels(zone: ZoneEntry): Promise<void> {
    const c = this.c;
    const now = this.now();
    const statement = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ${c.state} = 'cancelled', ${c.settledAt} = ${now}, ` +
          `${c.claimToken} = NULL, ${c.leaseUntil} = NULL, ${c.dyingError} = NULL WHERE ${c.seq} IN (` +
          `SELECT ${c.seq} FROM ${this.table} WHERE ${c.queueName} = `,
      )
      .value(this.name)
      .text(
        ` AND ${c.state} = 'running' AND ${c.cancelRequested} = 1 AND ${c.leaseUntil} <= ${now} LIMIT `,
      )
      .value(LAPSED_CANCEL_BATCH)
      .text(` ${this.schema.skipLockedClause()})`);
    await this.statement(statement, zone);
  }

  /**
   * The messages this claim takes: running messages whose lease lapsed, in the
   * order their leases lapsed, then pending messages whose visibility time has
   * come, earliest first and in enqueue order among equal times. Each is one
   * range of an index (`state`, then `lease_until` or `visible_at`), so a claim
   * reads only rows that are claimable now — never the messages scheduled for
   * later. Rows another claimer holds are passed over.
   */
  private async candidates(limit: number, zone: ZoneEntry): Promise<ClaimRow[]> {
    const lapsed = await this.candidatesIn("running", limit, zone);
    if (lapsed.length >= limit) return lapsed;
    return [...lapsed, ...(await this.candidatesIn("pending", limit - lapsed.length, zone))];
  }

  /**
   * One state's claimable rows. A lapsed running message asked to cancel is not
   * delivered (the claim settled it before). On a grouped queue a message is a
   * candidate only as the oldest unsettled message of its group — so a dead one
   * parks the group, and within a group delivery follows enqueue order whatever
   * the visibility times — and only while no other message of the group is held
   * under a live lease; at most one per group therefore qualifies. Each probe is
   * an index range over unsettled (or running) rows alone, so the settled
   * messages a group keeps for `retention` are never read.
   */
  private async candidatesIn(
    state: "running" | "pending",
    limit: number,
    zone: ZoneEntry,
  ): Promise<ClaimRow[]> {
    const c = this.c;
    const now = this.now();
    const due = state === "running" ? c.leaseUntil : c.visibleAt;
    const statement = new SqlFragments()
      .text(
        `SELECT m.${c.seq} AS seq, m.${c.messageId} AS message_id, m.${c.state} AS state, ` +
          `m.${c.body} AS body, m.${c.envelopeGeneration} AS envelope_generation, ` +
          `m.${c.enqueuedAt} AS enqueued_at, m.${c.dyingError} AS dying_error, ` +
          `m.${c.errorGeneration} AS error_generation, m.${c.traceparent} AS traceparent, ` +
          `m.${c.tracestate} AS tracestate FROM ${this.table} m WHERE m.${c.queueName} = `,
      )
      .value(this.name)
      .text(` AND m.${c.state} = '${state}' AND m.${due} <= ${now}`);
    if (state === "running") statement.text(` AND m.${c.cancelRequested} = 0`);
    if (this.groupBy) {
      // Each probe is a scalar subquery reading the first entry of one partial
      // index range — never `NOT EXISTS`, which a planner may answer by scanning
      // the table when its statistics say a match comes early. The state
      // predicates are written exactly as the partial indexes' `where:`, which
      // is what lets an engine match a probe to its index.
      statement.text(
        ` AND (m.${c.groupKey} IS NULL OR (` +
          `m.${c.seq} = (SELECT o.${c.seq} FROM ${this.table} o WHERE o.${c.queueName} = m.${c.queueName} ` +
          `AND o.${c.groupKey} = m.${c.groupKey} AND o.${c.state} IN ${UNSETTLED} ORDER BY o.${c.seq} LIMIT 1) ` +
          `AND (SELECT 1 FROM ${this.table} o WHERE o.${c.queueName} = m.${c.queueName} ` +
          `AND o.${c.groupKey} = m.${c.groupKey} AND o.${c.state} = 'running' AND o.${c.seq} > m.${c.seq} ` +
          `AND o.${c.leaseUntil} > ${now} LIMIT 1) IS NULL))`,
      );
    }
    statement
      .text(` ORDER BY m.${due}, m.${c.seq} LIMIT `)
      .value(limit)
      .text(` ${this.schema.skipLockedClause()}`);
    const result = await this.statement<ClaimRow>(statement, zone);
    return result.rows;
  }

  /** Takes the candidates under one claim token and a fresh lease, counting the
   *  attempt; answers each row's attempt count after it. */
  private async markRunning(
    rows: readonly ClaimRow[],
    token: string,
    lease: CelDuration,
    zone: ZoneEntry,
  ): Promise<Map<string, number>> {
    const c = this.c;
    const statement = new SqlFragments()
      .text(`UPDATE ${this.table} SET ${c.state} = 'running', ${c.claimToken} = `)
      .value(token)
      .text(`, ${c.leaseUntil} = `)
      .append(this.schema.currentInstantPlus(lease))
      .text(`, ${c.attempts} = ${c.attempts} + 1 WHERE ${c.seq} IN (`)
      .valueList(
        rows.map((row) => readInt64Column(row.seq)),
        ", ",
      )
      .text(`) RETURNING ${c.seq} AS seq, ${c.attempts} AS attempts`);
    const result = await this.statement<{ seq: unknown; attempts: unknown }>(statement, zone);
    return new Map(result.rows.map((row) => [readInt64Column(row.seq).toString(), Number(row.attempts)]));
  }

  private claimedOf(row: ClaimRow, token: string, attempts: Map<string, number>): ClaimedMessage {
    const seq = readInt64Column(row.seq).toString();
    const attempt = attempts.get(seq);
    if (attempt === undefined) {
      throw new InvokeError(
        ERR_QUEUE_STORE_INCONSISTENT,
        `${this.describe}: claiming message '${row.message_id}' updated no row although the claim ` +
          `held it.`,
      );
    }
    const dying = decodeStoredError(row.dying_error, row.error_generation);
    return {
      id: row.message_id,
      claim: claimOf(seq, token),
      body: row.body,
      generation: Number(row.envelope_generation),
      attempt,
      enqueuedAt: timestampOf(row.enqueued_at),
      lapsed: row.state === "running",
      ...(dying ? { dying } : {}),
      ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
      ...(row.tracestate === null ? {} : { tracestate: row.tracestate }),
    };
  }

  /** How long until the next pending message becomes visible or the next lease
   *  lapses, on the store's clock; undefined when neither is ahead. Each is the
   *  first entry of one index range, so an idle claim reads two index entries
   *  whatever the queue holds. */
  private async msUntilNextVisible(): Promise<number | undefined> {
    const c = this.c;
    const now = this.now();
    const statement = new SqlFragments()
      .text(`SELECT (SELECT ${c.visibleAt} FROM ${this.table} WHERE ${c.queueName} = `)
      .value(this.name)
      .text(
        ` AND ${c.state} = 'pending' AND ${c.visibleAt} > ${now} ORDER BY ${c.visibleAt} LIMIT 1) AS next_visible, ` +
          `(SELECT ${c.leaseUntil} FROM ${this.table} WHERE ${c.queueName} = `,
      )
      .value(this.name)
      .text(
        ` AND ${c.state} = 'running' AND ${c.leaseUntil} > ${now} ORDER BY ${c.leaseUntil} LIMIT 1) AS next_lapse, ` +
          `${now} AS now`,
      );
    const result = await this.statement<{ next_visible: unknown; next_lapse: unknown; now: unknown }>(statement);
    const [row] = result.rows;
    if (!row) return undefined;
    const due = [row.next_visible, row.next_lapse]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => readTimestampColumn(value).getTime());
    if (due.length === 0) return undefined;
    return Math.max(0, Math.min(...due) - readTimestampColumn(row.now).getTime()) + 1;
  }

  // ---------------------------------------------------------- held claims

  async renew(claim: string, lease: CelDuration, ctx?: InvokeContext): Promise<RenewOutcome> {
    const held = parseClaim(claim);
    if (!held) return { status: "lost" };
    const c = this.c;
    const now = this.now();
    const cancelled = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ${c.state} = 'cancelled', ${c.settledAt} = ${now}, ${c.claimToken} = NULL, ` +
          `${c.leaseUntil} = NULL, ${c.dyingError} = NULL WHERE `,
      )
      .append(this.heldBy(held))
      .text(` AND ${c.cancelRequested} = 1 RETURNING ${c.seq} AS seq`);
    if ((await this.statement(cancelled, undefined, ctx)).rows.length > 0) {
      if (this.groupBy) await this.wakeAfterCommit();
      return { status: "cancelled" };
    }
    const extended = new SqlFragments()
      .text(`UPDATE ${this.table} SET ${c.leaseUntil} = `)
      .append(this.schema.currentInstantPlus(lease))
      .text(" WHERE ")
      .append(this.heldBy(held))
      .text(` RETURNING ${c.seq} AS seq`);
    return (await this.statement(extended, undefined, ctx)).rows.length > 0 ? { status: "held" } : { status: "lost" };
  }

  async complete(claim: string, ctx?: InvokeContext): Promise<SettleOutcome> {
    const settled = await this.settle(claim, "'completed'", null, ctx);
    if (settled.status === "settled" && this.groupBy) await this.wakeAfterCommit();
    return settled;
  }

  async kill(claim: string, error: QueueError, ctx?: InvokeContext): Promise<SettleOutcome> {
    return this.settle(claim, "'dead'", error, ctx);
  }

  /**
   * Settles a held claim. A message whose cancel was requested while it ran is
   * settled `cancelled` instead when it dies; a completed one stays completed —
   * its work is done.
   */
  private async settle(
    claim: string,
    state: "'completed'" | "'dead'",
    error: QueueError | null,
    ctx: InvokeContext | undefined,
  ): Promise<SettleOutcome> {
    const held = parseClaim(claim);
    if (!held) return { status: "lost" };
    const c = this.c;
    const now = this.now();
    const target = state === "'dead'" ? `CASE WHEN ${c.cancelRequested} = 1 THEN 'cancelled' ELSE 'dead' END` : state;
    const statement = new SqlFragments().text(
      `UPDATE ${this.table} SET ${c.state} = ${target}, ${c.settledAt} = ${now}, ${c.claimToken} = NULL, ` +
        `${c.leaseUntil} = NULL, ${c.dyingError} = NULL`,
    );
    if (error) {
      statement
        .text(`, ${c.lastError} = `)
        .value(encodeStoredError(error))
        .text(`, ${c.errorGeneration} = `)
        .value(STORED_ERROR_GENERATION);
    }
    statement.text(" WHERE ").append(this.heldBy(held)).text(` RETURNING ${c.seq} AS seq`);
    const result = await this.statement(statement, undefined, ctx);
    return result.rows.length > 0 ? { status: "settled" } : { status: "lost" };
  }

  async release(claim: string, release: ReleaseRequest, ctx?: InvokeContext): Promise<SettleOutcome> {
    const held = parseClaim(claim);
    if (!held) return { status: "lost" };
    const c = this.c;
    const now = this.now();
    const statement = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ` +
          `${c.state} = CASE WHEN ${c.cancelRequested} = 1 THEN 'cancelled' ELSE 'pending' END, ` +
          `${c.settledAt} = CASE WHEN ${c.cancelRequested} = 1 THEN ${now} ELSE NULL END, ` +
          `${c.claimToken} = NULL, ${c.leaseUntil} = NULL, ${c.visibleAt} = `,
      )
      .append(this.schema.currentInstantPlus(ceilDurationToMillis(release.visibleAfter)));
    if (release.giveBack) statement.text(`, ${c.attempts} = ${c.attempts} - 1`);
    statement.text(`, ${c.dyingError} = `).value(release.dying ? encodeStoredError(release.dying) : null);
    if (release.error) statement.text(`, ${c.lastError} = `).value(encodeStoredError(release.error));
    if (release.error || release.dying) {
      statement.text(`, ${c.errorGeneration} = `).value(STORED_ERROR_GENERATION);
    }
    statement.text(" WHERE ").append(this.heldBy(held)).text(` RETURNING ${c.seq} AS seq`);
    const result = await this.statement(statement, undefined, ctx);
    if (result.rows.length === 0) return { status: "lost" };
    await this.wakeAfterCommit();
    return { status: "settled" };
  }

  /** The row a claim still holds: its seq, its token, running. */
  private heldBy(held: HeldClaim): SqlFragments {
    const c = this.c;
    return new SqlFragments()
      .text(`${c.seq} = `)
      .value(held.seq)
      .text(` AND ${c.claimToken} = `)
      .value(held.token)
      .text(` AND ${c.state} = 'running'`);
  }

  // ------------------------------------------------------------------ stats

  async stats(ctx?: InvokeContext): Promise<QueueStats> {
    const c = this.c;
    const now = this.now();
    const count = (condition: string) =>
      `CAST(COALESCE(SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END), 0) AS INTEGER)`;
    const statement = new SqlFragments()
      .text(
        `SELECT ${count(pendingCondition(c, now))} AS pending, ` +
          `${count(`${c.state} = 'pending' AND ${c.visibleAt} > ${now}`)} AS scheduled, ` +
          `${count(`${c.state} = 'running' AND ${c.leaseUntil} > ${now}`)} AS running, ` +
          `${count(`${c.state} = 'dead'`)} AS dead, ` +
          `MIN(CASE WHEN ${c.state} = 'pending' AND ${c.visibleAt} <= ${now} THEN ${c.visibleAt} ` +
          `WHEN ${c.state} = 'running' AND ${c.leaseUntil} <= ${now} THEN ${c.leaseUntil} ELSE NULL END) AS oldest, ` +
          `${now} AS now FROM ${this.table} WHERE ${c.queueName} = `,
      )
      .value(this.name);
    const result = await this.statement<{
      pending: unknown;
      scheduled: unknown;
      running: unknown;
      dead: unknown;
      oldest: unknown;
      now: unknown;
    }>(statement, undefined, ctx);
    const row = result.rows[0]!;
    const oldest =
      row.oldest === null || row.oldest === undefined
        ? null
        : durationOfMillis(
            Math.max(0, readTimestampColumn(row.now).getTime() - readTimestampColumn(row.oldest).getTime()),
          );
    return {
      pending: Number(row.pending),
      scheduled: Number(row.scheduled),
      running: Number(row.running),
      dead: Number(row.dead),
      oldestPendingAge: oldest,
      exact: true,
    };
  }

  // ------------------------------------------------------------ addressable

  async get(id: string, ctx?: InvokeContext): Promise<StoredMessageFound | StoredMessageAbsent> {
    const c = this.c;
    const statement = this.selectMessages()
      .text(` AND ${c.messageId} = `)
      .value(id)
      .text(" AND ")
      .append(this.live());
    const result = await this.statement<MessageRow>(statement, undefined, ctx);
    const [row] = result.rows;
    if (!row) return { status: "absent" };
    const shown = this.storedOf(row);
    return {
      status: "found",
      message: {
        ...shown,
        ...(row.cancel_reason === null ? {} : { reason: row.cancel_reason }),
        body: row.body,
        generation: Number(row.envelope_generation),
      },
    };
  }

  async list(request: ListRequest, ctx?: InvokeContext): Promise<ListOutcome> {
    let after: bigint | undefined;
    if (request.after !== undefined) {
      if (!/^(?:0|[1-9][0-9]{0,18})$/.test(request.after)) return { status: "cursorInvalid" };
      after = BigInt(request.after);
      if (after > 2n ** 63n - 1n) return { status: "cursorInvalid" };
    }
    const c = this.c;
    const statement = this.selectMessages().text(" AND ").append(this.inState(request.state));
    if (after !== undefined) statement.text(` AND ${c.seq} > `).value(after);
    statement.text(` ORDER BY ${c.seq} LIMIT `).value(request.limit + 1);
    const result = await this.statement<MessageRow>(statement, undefined, ctx);
    const rows = result.rows.slice(0, request.limit);
    const more = result.rows.length > request.limit;
    return {
      status: "page",
      messages: rows.map((row) => this.storedOf(row)),
      ...(more ? { next: readInt64Column(rows[rows.length - 1]!.seq).toString() } : {}),
    };
  }

  async cancel(id: string, reason: string | null, ctx?: InvokeContext): Promise<CancelOutcome> {
    const c = this.c;
    const now = this.now();
    const settled = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ${c.state} = 'cancelled', ${c.settledAt} = ${now}, ${c.claimToken} = NULL, ` +
          `${c.leaseUntil} = NULL, ${c.dyingError} = NULL, ${c.cancelReason} = `,
      )
      .value(reason)
      .text(" WHERE ")
      .append(this.byId(id))
      .text(
        ` AND (${c.state} IN ('pending', 'dead') OR (${c.state} = 'running' AND ${c.leaseUntil} <= ${now})) ` +
          `RETURNING ${c.seq} AS seq`,
      );
    if ((await this.statement(settled, undefined, ctx)).rows.length > 0) {
      if (this.groupBy) await this.wakeAfter(ctx);
      return { status: "cancelled" };
    }
    const requested = new SqlFragments()
      .text(`UPDATE ${this.table} SET ${c.cancelRequested} = 1, ${c.cancelReason} = `)
      .value(reason)
      .text(" WHERE ")
      .append(this.byId(id))
      .text(` AND ${c.state} = 'running' RETURNING ${c.seq} AS seq`);
    if ((await this.statement(requested, undefined, ctx)).rows.length > 0) return { status: "requested" };
    const found = await this.get(id, ctx);
    return found.status === "found" ? { status: "unchanged", state: found.message.state } : { status: "absent" };
  }

  async requeue(id: string, ctx?: InvokeContext): Promise<RequeueOutcome> {
    const c = this.c;
    const now = this.now();
    const statement = new SqlFragments()
      .text(
        `UPDATE ${this.table} SET ${c.state} = 'pending', ${c.visibleAt} = ${now}, ${c.attempts} = 0, ` +
          `${c.settledAt} = NULL, ${c.dyingError} = NULL WHERE `,
      )
      .append(this.byId(id))
      .text(` AND ${c.state} = 'dead' RETURNING ${c.seq} AS seq`);
    if ((await this.statement(statement, undefined, ctx)).rows.length > 0) {
      await this.wakeAfter(ctx);
      return { status: "requeued" };
    }
    const found = await this.get(id, ctx);
    return found.status === "found" ? { status: "unchanged", state: found.message.state } : { status: "absent" };
  }

  private byId(id: string): SqlFragments {
    const c = this.c;
    return new SqlFragments()
      .text(`${c.queueName} = `)
      .value(this.name)
      .text(` AND ${c.messageId} = `)
      .value(id);
  }

  private selectMessages(): SqlFragments {
    const c = this.c;
    const now = this.now();
    return new SqlFragments()
      .text(
        `SELECT ${c.seq} AS seq, ${c.messageId} AS message_id, ` +
          `CASE WHEN ${c.state} = 'pending' AND ${c.visibleAt} > ${now} THEN 'scheduled' ` +
          `WHEN ${c.state} = 'running' AND ${c.leaseUntil} <= ${now} THEN 'pending' ` +
          `ELSE ${c.state} END AS shown_state, ${c.attempts} AS attempts, ${c.enqueuedAt} AS enqueued_at, ` +
          `${c.visibleAt} AS visible_at, ${c.settledAt} AS settled_at, ${c.lastError} AS last_error, ` +
          `${c.errorGeneration} AS error_generation, ${c.cancelReason} AS cancel_reason, ${c.body} AS body, ` +
          `${c.envelopeGeneration} AS envelope_generation FROM ${this.table} WHERE ${c.queueName} = `,
      )
      .value(this.name);
  }

  /** The rows a listing of `state` reads, judged on the store's clock. */
  private inState(state: MessageState): SqlFragments {
    const c = this.c;
    const now = this.now();
    switch (state) {
      case "scheduled":
        return new SqlFragments().text(`${c.state} = 'pending' AND ${c.visibleAt} > ${now}`);
      case "pending":
        return new SqlFragments().text(`(${pendingCondition(c, now)})`);
      case "running":
        return new SqlFragments().text(`${c.state} = 'running' AND ${c.leaseUntil} > ${now}`);
      case "dead":
        return new SqlFragments().text(`${c.state} = 'dead'`);
      case "completed":
      case "cancelled":
        return new SqlFragments().text(`${c.state} = `).value(state).text(" AND ").append(this.live());
    }
  }

  /** A settled message whose retention has passed, under alias `prefix`. */
  private expired(prefix: string): SqlFragments {
    const c = this.c;
    return new SqlFragments()
      .text(`${prefix}${c.state} IN ${EXPIRING} AND ${prefix}${c.settledAt} < `)
      .append(this.stable(this.schema.currentInstantPlus(this.expiryShift)));
  }

  /** Every message that has not expired. */
  private live(): SqlFragments {
    const c = this.c;
    return new SqlFragments()
      .text(`(${c.state} NOT IN ${EXPIRING} OR ${c.settledAt} >= `)
      .append(this.stable(this.schema.currentInstantPlus(this.expiryShift)))
      .text(")");
  }

  private storedOf(row: MessageRow) {
    const state = row.shown_state as MessageState;
    const lastError = decodeStoredError(row.last_error, row.error_generation);
    const settled = state === "completed" || state === "dead" || state === "cancelled";
    return {
      id: row.message_id,
      state,
      attempts: Number(row.attempts),
      enqueuedAt: timestampOf(row.enqueued_at),
      ...(settled ? {} : { visibleAt: timestampOf(row.visible_at) }),
      ...(settled && row.settled_at !== null ? { settledAt: timestampOf(row.settled_at) } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  // ---------------------------------------------------------------- shared

  /** The store's current instant, read once for the statement holding it. An
   *  instant function is volatile, so compared bare against an indexed column it
   *  is a filter applied to every row; as an uncorrelated subquery it is one
   *  value the engine can seek an index to. */
  private now(): string {
    return `(SELECT ${this.schema.currentInstant()})`;
  }

  /** An instant expression read once for the statement holding it (see {@link now}). */
  private stable(instant: SqlFragments): SqlFragments {
    return new SqlFragments().text("(SELECT ").append(instant).text(")");
  }

  /** A zone entry for one transaction of the store's own. Fresh each time: the
   *  connection keys its open executor on the entry, so two transactions
   *  sharing one entry would run on each other's executor. */
  private ownZone(): ZoneEntry {
    return { kind: this.ctx.self.ref.kind, provider: this.ctx.self };
  }

  private statement<T = Record<string, unknown>>(
    statement: SqlFragments,
    zone?: ZoneEntry,
    ctx?: InvokeContext,
  ) {
    return this.connection.executeTemplate<T>(statement.fragments, statement.boundValues, zone, ctx);
  }

  /** A wake sent by an operation the caller ran: inside the caller's open
   *  transaction it is held until commit, so it fails with the operation. */
  private async wakeAfter(ctx: InvokeContext | undefined): Promise<void> {
    if (!this.wake) return;
    if (this.boundZone(ctx)) await this.wake.notify();
    else await this.wakeAfterCommit();
  }

  /** A wake after the store's own write committed. It only makes a claim
   *  prompt, so a failure to send one is reported and the operation stands. */
  private async wakeAfterCommit(): Promise<void> {
    if (!this.wake) return;
    try {
      await this.wake.notify();
    } catch (error) {
      this.ctx.log.warn(
        "Sending the queue's wake notification failed; workers find the message at their next poll",
        { "telo.queue.wake.channel": this.wake.channel },
        { error },
      );
    }
  }
}

interface HeldClaim {
  readonly seq: bigint;
  readonly token: string;
}

function claimOf(seq: string, token: string): string {
  return `${seq}.${token}`;
}

/** A claim token this store issued, or undefined for any other text — which
 *  holds nothing. */
function parseClaim(claim: string): HeldClaim | undefined {
  const match = /^(0|[1-9][0-9]{0,18})\.([0-9a-f]{32})$/.exec(claim);
  if (!match) return undefined;
  const seq = BigInt(match[1]!);
  return seq > 2n ** 63n - 1n ? undefined : { seq, token: match[2]! };
}

/** Pending and visible, or running with a lapsed lease: claimable now. */
function pendingCondition(c: QueueColumns, now: string): string {
  return (
    `(${c.state} = 'pending' AND ${c.visibleAt} <= ${now}) OR ` +
    `(${c.state} = 'running' AND ${c.leaseUntil} <= ${now})`
  );
}

function timestampOf(value: unknown): CelTimestamp {
  const timestamp = celTimestampFromMillis(readTimestampColumn(value).getTime());
  if (!isCelTimestamp(timestamp)) throw new RangeError(`A stored instant is outside a timestamp's range.`);
  return timestamp;
}

function durationOfMillis(ms: number): CelDuration {
  const duration = celDurationFromNanos(BigInt(Math.round(ms)) * NANOS_PER_MILLI);
  if (!isCelDuration(duration)) throw new RangeError(`An age of ${ms}ms is outside a duration's range.`);
  return duration;
}

/** A duration rounded up to whole milliseconds — the coarsest precision an
 *  engine stores — so a visibility time is never earlier than asked. */
export function ceilDurationToMillis(duration: CelDuration): CelDuration {
  const nanos = durationNanos(duration);
  const rounded = nanos <= 0n ? nanos : ((nanos + NANOS_PER_MILLI - 1n) / NANOS_PER_MILLI) * NANOS_PER_MILLI;
  const result = celDurationFromNanos(rounded);
  if (!isCelDuration(result)) throw new RangeError(`A delay is outside a duration's range.`);
  return result;
}

/** An instant rounded up to whole milliseconds, for the same reason. */
export function ceilTimestampToMillis(timestamp: CelTimestamp): CelTimestamp {
  const nanos = timestampNanos(timestamp);
  const millis = nanos / NANOS_PER_MILLI + (nanos % NANOS_PER_MILLI > 0n ? 1n : 0n);
  const result = celTimestamp(0n, millis * NANOS_PER_MILLI);
  if (!isCelTimestamp(result)) throw new RangeError(`An instant is outside a timestamp's range.`);
  return result;
}
