/**
 * The `Text` record: what a controller receives wherever a field or a callable
 * parameter is typed by the built-in `Text` fragment.
 *
 * The kernel builds it — at creation for a field, at call binding for an argument —
 * from the text as written and the module that wrote it:
 *
 * - `text` is the Message in its fragment spelling, as written and validated: a
 *   pattern string, or `{ plural, cases }` whose cases are Messages. Read it with
 *   `readMessage` (or the whole record's `text` / `context` with `readText`).
 * - `context` tells the same words used elsewhere apart; `null` when none is written.
 * - `lang` is the writing module's `lang:`, or `und` when it declares none — the
 *   language the source is selected in when no translation applies.
 * - `computed` is true when an expression produced the text: such a text is never
 *   looked up in a catalog.
 *
 * Plain JSON, so a record crosses any wire unchanged.
 */

/** A Message in its fragment spelling. */
export type MessageSource =
  | string
  | { readonly plural: string; readonly cases: Readonly<Record<string, MessageSource>> };

export interface TextRecord {
  readonly text: MessageSource;
  readonly context: string | null;
  readonly lang: string;
  readonly computed: boolean;
}

const RECORD_KEYS = ["computed", "context", "lang", "text"];

/** True for a value shaped as a {@link TextRecord}: exactly its four keys, `lang` a
 *  string, `computed` a boolean, `context` a string or null. */
export function isTextRecord(value: unknown): value is TextRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, at) => key !== RECORD_KEYS[at])) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.lang === "string" &&
    typeof record.computed === "boolean" &&
    (record.context === null || typeof record.context === "string") &&
    record.text !== undefined
  );
}
