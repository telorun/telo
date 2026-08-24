import { isTaggedSentinel } from "@telorun/templating";
import { isRecord } from "../../../lib/utils";

/**
 * What a manifest value holds, in one line.
 *
 * One function because every list in the topology tab asks the same question —
 * the property rail about a field, an entry row about a mount's `path`, a step
 * row about a guard — and two spellings of it would eventually render the same
 * value two ways. It was written twice before this (`summarizeValue` and
 * `entryFieldText`), and the second one's doc already said it gave "the same
 * one-line reading the property rail gives", which is the argument for calling
 * it rather than copying it.
 *
 * A COUNT rather than the contents for a list: the caller's job is to say
 * whether a value is worth opening, and a truncated rendering of a route table
 * answers that no better than "6 entries" while reading as though it were the
 * value. A scalar is shown, because there the contents ARE the summary.
 */
export function summarizeValue(value: unknown): string {
  if (value === undefined) return "not set";
  if (value === null) return "null";
  // A `!cel` / `!ref` sentinel: what the author wrote IS the value here, so it
  // is the one object whose contents belong on the row verbatim. The shape is
  // templating's to know — a `__tagged` test spelled out here is a copy of a
  // predicate that already exists, and one that silently stops matching the day
  // the sentinel gains a field.
  if (isTaggedSentinel(value) && typeof value.source === "string") return value.source;
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "entry" : "entries"}`;
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 0 ? "empty" : keys.join(", ");
  }
  return String(value);
}

/** The source of a `!cel` / `!ref` sentinel, or the value rendered as text.
 *  What a guard or a condition reads as where the value is known to be a scalar
 *  or an expression. */
export function authoredText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (isTaggedSentinel(value) && typeof value.source === "string") return value.source;
  return String(value);
}
