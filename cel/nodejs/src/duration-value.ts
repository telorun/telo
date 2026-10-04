/**
 * Durations: reading one, writing one, and the fields of one.
 *
 * **CEL's duration is the signed 64-bit range of its total NANOSECONDS** —
 * `-9223372036.854775808s … 9223372036.854775807s`, roughly ±292 years. That is cel-spec's
 * own rule, stated under *Overflow* in its language definition ("Duration values are
 * limited to a single int64 value, or roughly +-290 years"), and all six of the vectors'
 * `timestamps/duration_range` rows read it: each uses an operand of 200,000,000,000s or
 * 320,000,000,000s and each expects `duration out of range`.
 *
 * **It is a subrange of the typed frame's, deliberately.** The frame carries protobuf's
 * `google.protobuf.Duration` range — ±315,576,000,000s, ±10,000 years — because a duration
 * arriving from a transport, a journal or a controller must always be representable, and
 * narrowing the frame to CEL's range would make such a value unwritable. So CEL ⊂ frame:
 * `duration('200000000000s')` is a value the frame carries and CEL cannot construct, which
 * is the correct answer rather than a cost. Nothing about the frame changes here.
 *
 * The range is an invariant, not a storage format: a duration is still seconds and
 * nanoseconds of the same sign, with `|nanos| < 1e9`, and nanosecond-precise. A computation
 * that leaves the range is an error, never a value outside it.
 *
 * It is written as seconds with an `s` suffix (`1000000s`, `-1.5s`), which is cel-spec's
 * own spelling, and the one plain encoding a duration has wherever it is written down.
 */

import { celError, CEL_VALUE_TYPE, isCelError, type CelDuration, type CelError } from "./cel-value.js";
import type { SourceRange } from "./syntax-tree.js";

/** The widest and narrowest total a duration holds, in nanoseconds: int64. */
export const MAX_DURATION_NANOS = 9_223_372_036_854_775_807n;
export const MIN_DURATION_NANOS = -9_223_372_036_854_775_808n;

const NANOS_PER_SECOND = 1_000_000_000n;

/** A duration from a total in nanoseconds, or the range error. */
export function celDurationFromNanos(total: bigint, range?: SourceRange): CelDuration | CelError {
  if (total > MAX_DURATION_NANOS || total < MIN_DURATION_NANOS) {
    return celError("invalid_conversion", "duration out of range", range);
  }
  return {
    [CEL_VALUE_TYPE]: "google.protobuf.Duration",
    seconds: total / NANOS_PER_SECOND,
    nanos: Number(total % NANOS_PER_SECOND),
  };
}

/**
 * The error a duration **this engine did not build** is outside CEL's range: one from a
 * host, which the frame's wider range admits. Checked where such a duration is used, not
 * where it arrives, so a value merely passing through is not judged.
 */
export function durationOutOfRange(value: CelDuration, range?: SourceRange): CelError | undefined {
  const total = durationNanos(value);
  if (total <= MAX_DURATION_NANOS && total >= MIN_DURATION_NANOS) return undefined;
  return celError("invalid_conversion", "duration out of range", range);
}

/** The duration's total nanoseconds — what arithmetic and ordering compare. */
export function durationNanos(value: CelDuration): bigint {
  return value.seconds * NANOS_PER_SECOND + BigInt(value.nanos);
}

const UNIT_NANOS: Readonly<Record<string, bigint>> = {
  ns: 1n,
  us: 1_000n,
  "µs": 1_000n,
  "μs": 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};

const PART = /([0-9]*)(?:\.([0-9]*))?(ns|us|µs|μs|ms|s|m|h)/g;

/**
 * A duration from CEL's own text: a sign, then one or more number-and-unit parts over
 * `ns`, `us`, `ms`, `s`, `m` and `h` (`1h30m`, `1.5s`, `-10m`).
 */
export function parseDuration(text: string, range?: SourceRange): CelDuration | CelError {
  const total = durationNanosFromText(text, range);
  return isCelError(total) ? total : celDurationFromNanos(total, range);
}

/**
 * The same text as a TOTAL OF NANOSECONDS, with no range applied.
 *
 * The grammar and the range are separate questions, and a consumer outside CEL has the same
 * grammar with a different range: protobuf's `google.protobuf.Duration` reaches ±10,000
 * years, which **cannot be held in an int64 of nanoseconds at all**, so a reader that must
 * carry one (a journal entry, a value off a transport) cannot go through `parseDuration` and
 * would otherwise restate this grammar. It answers an unbounded `bigint`; applying a range
 * is the caller's, and `celDurationFromNanos` is what applies CEL's.
 */
export function durationNanosFromText(text: string, range?: SourceRange): bigint | CelError {
  const refuse = () =>
    celError("invalid_conversion", `${JSON.stringify(text)} is not a duration`, range);
  let body = text;
  let negative = false;
  if (body.startsWith("+") || body.startsWith("-")) {
    negative = body.startsWith("-");
    body = body.slice(1);
  }
  if (body === "0") return 0n;
  if (body === "") return refuse();
  PART.lastIndex = 0;
  let total = 0n;
  let at = 0;
  for (let found = PART.exec(body); found; found = PART.exec(body)) {
    if (found.index !== at) return refuse();
    const [whole, digits, fraction, unit] = found;
    if (!digits && !fraction) return refuse();
    const scale = UNIT_NANOS[unit!]!;
    total += BigInt(digits || "0") * scale;
    if (fraction) {
      const padded = `${fraction}000000000`.slice(0, 9);
      total += (BigInt(padded) * scale) / NANOS_PER_SECOND;
    }
    at += whole.length;
  }
  if (at !== body.length) return refuse();
  return negative ? -total : total;
}

/** Seconds with an `s` suffix, the fraction trimmed to what it carries. */
export function formatDuration(value: CelDuration): string {
  const total = durationNanos(value);
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const seconds = magnitude / NANOS_PER_SECOND;
  const nanos = magnitude % NANOS_PER_SECOND;
  const fraction = nanos === 0n ? "" : `.${String(nanos).padStart(9, "0").replace(/0+$/, "")}`;
  return `${negative ? "-" : ""}${seconds}${fraction}s`;
}

/** Which field of a duration a getter answers. */
export type DurationField = "getHours" | "getMinutes" | "getSeconds" | "getMilliseconds";

/**
 * A field of a duration. `getHours`, `getMinutes` and `getSeconds` answer the **whole span**
 * in that unit, truncated toward zero; `getMilliseconds` answers the **component** — the
 * milliseconds inside the second, so `duration('123.321456789s').getMilliseconds()` is 321
 * and not 123,321.
 *
 * That split is cel-spec's, and it is also the only reading under which the engine does not
 * contradict itself: a timestamp's `getMilliseconds()` has always answered the component.
 */
export function durationField(value: CelDuration, field: DurationField): bigint {
  const total = durationNanos(value);
  switch (field) {
    case "getHours":
      return total / 3_600_000_000_000n;
    case "getMinutes":
      return total / 60_000_000_000n;
    case "getSeconds":
      return total / NANOS_PER_SECOND;
    case "getMilliseconds":
      return BigInt(Math.trunc(value.nanos / 1_000_000));
  }
}
