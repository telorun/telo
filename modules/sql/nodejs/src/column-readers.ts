/**
 * How a consumer reads two column types whose driver form differs by engine,
 * without naming one. A 64-bit integer arrives as a JavaScript number, a bigint
 * or — where the driver will not risk precision — decimal text; an instant
 * arrives as a `Date`, or as the fixed-width UTC text an engine without a
 * timestamp type stores.
 */

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The value of an int64 column, exact across its whole range. */
export function readInt64Column(value: unknown): bigint {
  let read: bigint | undefined;
  if (typeof value === "bigint") read = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) read = BigInt(value);
  else if (typeof value === "string" && /^-?\d+$/.test(value)) read = BigInt(value);
  if (read === undefined || read < INT64_MIN || read > INT64_MAX) {
    throw new Error(
      `Expected a 64-bit integer column value, got ${typeof value === "string" ? `'${value}'` : String(value)} ` +
        `(${typeof value}). A number past 2^53 has already lost precision in the driver.`,
    );
  }
  return read;
}

const INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The value of a timestamp column: the driver's own date, or the fixed-width
 *  UTC text (`YYYY-MM-DDTHH:MM:SS.sssZ`) an engine without a timestamp type
 *  stores. */
export function readTimestampColumn(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && INSTANT_TEXT.test(value)) {
    const read = new Date(value);
    if (!Number.isNaN(read.getTime())) return read;
  }
  throw new Error(
    `Expected a timestamp column value — a date, or UTC text as YYYY-MM-DDTHH:MM:SS.sssZ — got ` +
      `${typeof value === "string" ? `'${value}'` : String(value)} (${typeof value}).`,
  );
}
