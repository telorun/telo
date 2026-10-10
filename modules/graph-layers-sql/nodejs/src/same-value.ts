import { isCelRecord } from "@telorun/sdk";

/**
 * Two values are the same value. This is the one equality the layered stores
 * decide by: whether both sides of a merge did the same, and whether a write
 * changes what its layer already states.
 *
 * Equality is by the value's own type, and the column's type is never
 * consulted. Two values are the same only when both are absent or null; both
 * are strings of the same text; both are booleans of the same value; both are
 * numbers of the same value, or integers of the same value where either is
 * held as an int64; both are bytes of the same content; both are host dates at
 * the same instant; both are lists of equal length whose elements are the same
 * pairwise; or both are plain maps with the same key set whose values are the
 * same per key, in any key order. Everything else is different: text never
 * equals a number or a boolean, and decimal text never equals an integer — on
 * an open column the string `"7"` and the integer `7` are two values.
 *
 * So it errs toward "different", which costs one write, never a lost one. A
 * column an engine hands back as text where it holds a number (PostgreSQL
 * `bigint` / `numeric`) therefore reads as changed by an equal number.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "string" || typeof a === "boolean") return a === b;
  if (typeof a === "number") {
    return typeof b === "bigint" ? Number.isInteger(a) && BigInt(a) === b : a === b;
  }
  if (typeof a === "bigint") {
    return typeof b === "number" ? Number.isInteger(b) && a === BigInt(b) : a === b;
  }
  if (a instanceof Uint8Array) {
    return (
      b instanceof Uint8Array && a.length === b.length && a.every((byte, index) => byte === b[index])
    );
  }
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((element, index) => sameValue(element, b[index]))
    );
  }
  if (!isCelRecord(a) || !isCelRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
  );
}

/** A write's given values all equal what `row` already holds. */
export function changesNothing(
  row: Record<string, unknown>,
  assignments: readonly { readonly column: { readonly name: string }; readonly value: unknown }[],
): boolean {
  return assignments.every((assignment) => sameValue(row[assignment.column.name], assignment.value));
}
