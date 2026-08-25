import { InvokeError, type ResourceContext } from "@telorun/sdk";
import type { Accessor } from "./chart-resource.js";

/**
 * Turning declared rows into drawable values, and refusing the two shapes of
 * bad data.
 *
 * The accessors are CEL over `row`, evaluated per row against a scope carrying
 * `row`, `index`, `rows` and the call's `inputs` — the same shape
 * `Collection.GroupBy` binds for its key expressions.
 */

export const DATA_INVALID = "ERR_CHART_DATA_INVALID";

export interface RowScope {
  inputs: Record<string, unknown>;
  rows: unknown[];
}

/** Reads the declared `rows` expression. Zero rows is not an error — an empty
 *  result set renders an empty plot — but a non-array is: it means the
 *  expression pointed at something that is not a collection. */
export function readRows(
  ctx: ResourceContext,
  declared: unknown,
  inputs: Record<string, unknown>,
  describe: string,
): unknown[] {
  const rows = ctx.expandValue(declared, { inputs });
  if (!Array.isArray(rows)) {
    throw new InvokeError(
      DATA_INVALID,
      `${describe}: 'rows' did not resolve to an array (got ${describeValue(rows)}).`,
    );
  }
  return rows;
}

export function evaluate(
  ctx: ResourceContext,
  accessor: Accessor,
  row: unknown,
  index: number,
  scope: RowScope,
): unknown {
  return ctx.expandValue(accessor, {
    inputs: scope.inputs,
    rows: scope.rows,
    row,
    index,
  });
}

/**
 * A number an axis or a slice can be drawn from.
 *
 * Null and non-finite are a HARD failure naming the row and the accessor,
 * because they are a defect in the data or in the expression, and a chart that
 * silently skipped them would draw a picture that is wrong in a way nobody can
 * see. Dates and numeric strings convert, because that is what arrives from a
 * database driver or a JSON payload rather than a mistake.
 */
export function requireNumber(
  value: unknown,
  index: number,
  accessor: string,
  describe: string,
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "bigint"
        ? Number(value)
        : value instanceof Date
          ? value.getTime()
          : typeof value === "string" && value.trim() !== ""
            ? Number(value)
            : Number.NaN;
  if (!Number.isFinite(numeric)) {
    throw new InvokeError(
      DATA_INVALID,
      `${describe}: '${accessor}' produced ${describeValue(value)} for row ${index}; ` +
        `a chart needs a finite number there. Filter or default the value upstream.`,
    );
  }
  return numeric;
}

/** The label a category, a series or a band is known by. Stringified rather
 *  than required to be a string: a numeric or date key is a legitimate grouping
 *  and would otherwise need a `string(...)` in every accessor. */
export function requireKey(
  value: unknown,
  index: number,
  accessor: string,
  describe: string,
): string {
  if (value === null || value === undefined) {
    throw new InvokeError(
      DATA_INVALID,
      `${describe}: '${accessor}' produced ${describeValue(value)} for row ${index}; ` +
        `a chart needs a value to name that mark by.`,
    );
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    throw new InvokeError(
      DATA_INVALID,
      `${describe}: '${accessor}' produced an object for row ${index}; ` +
        `a chart needs a scalar to name that mark by. Build a composite key with an expression ` +
        `(e.g. !cel "row.region + ' / ' + row.tier").`,
    );
  }
  return String(value);
}

/**
 * Refuses a key two rows share, on the encodings that draw one mark per key.
 *
 * A duplicate means the rows were not aggregated the way the author believed.
 * Summing silently would draw a picture that is wrong with nothing to notice,
 * and keeping the last row would discard data — so it is the same class of
 * failure as a non-finite value, and reported the same way. Both row indices
 * are named, because the fix is upstream of whichever one is wrong.
 */
export class KeyGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly describe: string,
    private readonly what: string,
  ) {}

  claim(key: string, index: number): void {
    const first = this.seen.get(key);
    if (first !== undefined) {
      throw new InvokeError(
        DATA_INVALID,
        `${this.describe}: rows ${first} and ${index} both have ${this.what} '${key}', ` +
          `and this chart draws one mark per ${this.what.split(" ")[0]}. ` +
          `Aggregate the rows first — Collection.GroupBy sums or averages them into one row per key.`,
      );
    }
    this.seen.set(key, index);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "no value";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
