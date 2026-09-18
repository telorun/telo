/**
 * SQLite has no boolean storage class: `true` and `false` are the convention of
 * 1 and 0 over `integer`, which is already what a declared column DEFAULT
 * renders as. The two drivers do not agree on binding one — bun:sqlite coerces,
 * better-sqlite3 refuses anything but numbers, strings, bigints, buffers and
 * null — so a manifest writing a boolean worked under Bun and failed under Node
 * with "SQLite3 can only bind numbers, strings, bigints, buffers, and null".
 * The conversion is stated once here and applied by both drivers.
 */
export function toSqliteBindings(params: ReadonlyArray<unknown>): unknown[] {
  return params.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
}
