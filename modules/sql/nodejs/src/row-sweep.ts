import {
  celDurationFromNanos,
  durationNanos,
  isCelDuration,
  type CelDuration,
  type ResourceContext,
  type ZoneEntry,
} from "@telorun/sdk";
import type { SqlFragments } from "./sql-fragments.js";
import type { SqlConnection } from "./sql-connection.js";

/** Rows one sweep statement removes at most. */
export const SWEEP_BATCH_ROWS = 500;
/** Statements one pass runs at most before waiting for the next. */
const SWEEP_BATCHES_PER_PASS = 20;
const SWEEP_MIN_INTERVAL_MS = 1_000;
const SWEEP_MAX_INTERVAL_MS = 60_000;

/** `retention` negated, the shift that turns "now" into the cut-off a row older
 *  than retention is judged against. */
export function retentionCutoffShift(retention: CelDuration, describe: string): CelDuration {
  const shift = celDurationFromNanos(-durationNanos(retention));
  if (!isCelDuration(shift)) {
    throw new Error(`${describe}: 'retention' is outside the range a duration can be negated in.`);
  }
  return shift;
}

export interface RowSweepOptions {
  readonly ctx: ResourceContext;
  readonly connection: SqlConnection;
  /** Sets the pass interval: the retention, clamped to 1 s – 60 s. */
  readonly retention: CelDuration;
  /** One bounded `DELETE`, skipping rows another transaction holds, removing at
   *  most {@link SWEEP_BATCH_ROWS}. Built per batch so the database's clock is
   *  read when it runs. */
  readonly batchStatement: () => SqlFragments;
  /** The warning worded when a pass fails; the next pass retries. */
  readonly failureMessage: string;
  readonly logAttributes: Record<string, string>;
}

/**
 * A background reclaimer of rows whose retention has passed: bounded,
 * lock-skipping batches, each its own short transaction, never in a caller's
 * transaction and holding nothing — so a finished application is never kept
 * alive by it. A sweep only frees space; whoever owns the rows judges
 * retention in its own statements.
 *
 * It starts once, from {@link startAt} (an owner's `run()`) or
 * {@link ensureStarted} (an owner's first use, a performed effect on the
 * owner's own frame), and teardown stops it and waits for a pass in flight.
 */
export class RowSweep {
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pass: Promise<void> | undefined;
  private stopped = true;
  private started = false;

  constructor(private readonly options: RowSweepOptions) {
    const retentionMs = Number(durationNanos(options.retention) / 1_000_000n);
    this.intervalMs = Math.min(SWEEP_MAX_INTERVAL_MS, Math.max(SWEEP_MIN_INTERVAL_MS, retentionMs));
  }

  /** Starts the sweep once; the returned closure stops it and waits for a pass
   *  in flight. A second start returns a closure that stops nothing, the first
   *  start's owner already stopping it at teardown. */
  startAt(delayMs: number): () => Promise<void> {
    if (this.started) return async () => {};
    this.started = true;
    this.stopped = false;
    this.schedule(delayMs);
    return () => this.stop();
  }

  /** Starts the sweep at the owner's first use, registered on the owner's frame
   *  so teardown stops it. A no-op once started. */
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    await this.options.ctx
      .effect("expired-row sweep", async () => ({
        result: undefined,
        inverse: this.startAt(this.intervalMs),
      }))
      .perform();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pass = this.sweep().finally(() => {
        this.pass = undefined;
        this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pass;
  }

  /** A failed pass is reported and the next one tries again: until a sweep
   *  succeeds, expired rows only cost space. */
  private async sweep(): Promise<void> {
    try {
      for (let batch = 0; batch < SWEEP_BATCHES_PER_PASS && !this.stopped; batch++) {
        if ((await this.sweepBatch()) < SWEEP_BATCH_ROWS) return;
      }
    } catch (error) {
      this.options.ctx.log.warn(this.options.failureMessage, this.options.logAttributes, { error });
    }
  }

  private async sweepBatch(): Promise<number> {
    const { ctx, connection } = this.options;
    const statement = this.options.batchStatement();
    const zone: ZoneEntry = { kind: ctx.self.ref.kind, provider: ctx.self };
    const result = await connection.runInTransaction((bind) => {
      bind(zone);
      return connection.executeTemplate(statement.fragments, statement.boundValues, zone);
    });
    return connection.toRowCount(result);
  }
}
