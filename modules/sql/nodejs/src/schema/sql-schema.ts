import type { CelDuration, CelTimestamp, ResourceInstance } from "@telorun/sdk";
import type { SqlFragments } from "../sql-fragments.js";
import type { DeclaredTable } from "./declared-schema.js";

/**
 * The contract every engine's `Schema` instance satisfies for a consumer that
 * addresses the tables it lists. The schema owns the namespace its tables live
 * in, so it is the one place a table reference is rendered: a consumer that
 * wrote a bare table name would reach whatever the session's default namespace
 * holds instead.
 */
export interface SqlSchema extends ResourceInstance {
  /** The qualified, quoted name of `table` in this schema's namespace, in the
   *  engine's own quoting. Throws when this schema does not list `table`. */
  qualifiedTableName(table: DeclaredTable): string;
}

/** True when an instance offers table addressing. An engine module older than
 *  the member does not, and a consumer must refuse it rather than address its
 *  tables unqualified. */
export function isSqlSchema(value: unknown): value is SqlSchema {
  return typeof (value as SqlSchema | undefined)?.qualifiedTableName === "function";
}

/**
 * A schema instance that also renders instants. The engine owns how an instant
 * is stored, so it is the one place "now" is written: a consumer that spelled
 * its own clock function would name an engine.
 */
export interface SqlInstantSchema extends SqlSchema {
  /**
   * The SQL expression for the instant the statement holding it runs — read
   * when that statement executes, never frozen at a transaction's start — in the
   * storage form of this engine's timestamp column. Values written through it
   * sort chronologically under a plain comparison of that column.
   */
  currentInstant(): string;
}

/** True when a schema instance renders the current instant. An engine module
 *  older than the member does not, and a consumer that records database time
 *  must refuse it rather than take a clock of its own. */
export function rendersCurrentInstant(value: unknown): value is SqlInstantSchema {
  return isSqlSchema(value) && typeof (value as SqlInstantSchema).currentInstant === "function";
}

/**
 * A schema instance that also adds time to an instant and binds one. The engine
 * owns interval arithmetic and the timestamp column's storage form, so it is the
 * one place "now plus a span" and "this instant" are written: a consumer that
 * spelled either would name an engine.
 *
 * Every member yields the storage form of this engine's timestamp column, so
 * values written through any of them order chronologically against those
 * written through `currentInstant()` under a plain comparison of that column, to
 * the engine's own precision.
 */
export interface SqlInstantArithmeticSchema extends SqlInstantSchema {
  /**
   * The instant the statement runs, shifted by a signed `Telo.Duration` (the
   * value the SDK hands a controller) — read as `currentInstant()` is. The
   * duration is a bound value in the returned fragments, never statement text.
   * Checks the value at run time too, throwing for one that is not a
   * duration, and throws for a shift the engine's timestamp column cannot
   * hold.
   */
  currentInstantPlus(duration: CelDuration): SqlFragments;
  /**
   * A bound `Telo.Timestamp` (the value the SDK hands a controller) in the
   * storage form of this engine's timestamp column, truncated toward the past
   * to the engine's precision. Checks the value at run time too, throwing for
   * one that is not a timestamp.
   */
  instantParameter(timestamp: CelTimestamp): SqlFragments;
}

/** True when a schema instance renders the current instant, shifts it and binds
 *  one. An engine module older than any of the three does not, and a consumer
 *  that needs them must refuse it rather than write its own arithmetic or
 *  timestamp text. */
export function rendersInstantArithmetic(value: unknown): value is SqlInstantArithmeticSchema {
  if (!rendersCurrentInstant(value)) return false;
  const schema = value as SqlInstantArithmeticSchema;
  return typeof schema.currentInstantPlus === "function" && typeof schema.instantParameter === "function";
}

/**
 * A schema instance that renders the lock-skipping clause of a row selection:
 * the text appended after a `SELECT … LIMIT n` so that rows another open
 * transaction holds are passed over rather than waited for. It composes inside
 * `UPDATE … WHERE id IN (SELECT … LIMIT n <clause>)` and the `DELETE` twin, on a
 * plain selection from one table (no `DISTINCT`, `GROUP BY`, aggregate or
 * `UNION`). An engine with a single writer has no row lock to skip and renders
 * nothing.
 */
export interface SqlLockSchema extends SqlSchema {
  /** The clause, or the empty string when the engine has no row locks. */
  skipLockedClause(): string;
}

/** True when a schema instance renders the lock-skipping clause. An engine
 *  module older than the member does not, and a consumer claiming rows
 *  concurrently must refuse it rather than select rows another claimant holds. */
export function rendersLockSkipping(value: unknown): value is SqlLockSchema {
  return isSqlSchema(value) && typeof (value as SqlLockSchema).skipLockedClause === "function";
}

/** The membership half of {@link SqlSchema.qualifiedTableName}, shared by the
 *  engines: `table` must be one `listed` declares. */
export function assertListedTable(
  describe: string,
  listed: readonly DeclaredTable[],
  table: DeclaredTable,
): void {
  if (!listed.some((declared) => declared.name === table.name)) {
    throw new Error(
      `${describe} does not list table '${table.name}' in 'tables:', so it does not address ` +
        `it. List the table there, or address it through the schema that does.`,
    );
  }
}
