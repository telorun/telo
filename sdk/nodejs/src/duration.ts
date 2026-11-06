/**
 * Duration parsing — the shared time helper for controllers. Telo writes human
 * durations (`250ms`, `2s`, `1.5m`, `1h`, `30d`) in manifests for timers, TTLs,
 * windows, connect timeouts, backoff, and so on; this is the single place that
 * turns one into a millisecond count. Consumers own their own error UX:
 * `tryParseDurationMs` returns `null` on a bad string so a caller can throw its
 * own typed error (e.g. an `InvokeError` for invoke-time input); `parseDurationMs`
 * throws a coded `RuntimeError` and treats `undefined` as a default (for optional
 * fields), so a bad duration in a manifest surfaces as a structured config error.
 *
 * This grammar is NOT `Telo.Duration`'s: it reads one number and one unit, while a
 * `Telo.Duration` slot reads CEL's grammar (`1h30m`, `1.5d`, units `ns` to `w`). Prefer a
 * `Telo.Duration` slot read with `durationMs`; a field moved from a string read here to
 * `Telo.Duration` changes which literals are valid, and is a breaking change for its kind.
 */
import { durationNanos, isCelDuration } from "./cel-value-identity.js";
import { RuntimeError } from "./types.js";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** @deprecated Declare the field as a `Telo.Duration` slot and read it with `durationMs`.
 *  Parse a duration string to milliseconds, or `null` if it is not a valid
 *  duration. Lets the caller own the error message and error type. */
export function tryParseDurationMs(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** @deprecated Declare the field as a `Telo.Duration` slot and read it with `durationMs`.
 *  Parse a duration string (`300s`, `5m`, `1h`, `30d`, `50ms`) to milliseconds. An
 *  `undefined` value yields `fallback` (default `0`) for optional fields; an
 *  invalid string throws a plain `Error`. */
export function parseDurationMs(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const ms = tryParseDurationMs(value);
  if (ms === null) {
    throw new RuntimeError(
      "ERR_INVALID_VALUE",
      `Invalid duration ${JSON.stringify(value)}; use a number with a unit, e.g. "250ms", "2s", "1.5m", "1h", "30d".`,
    );
  }
  return ms;
}

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * A `Telo.Duration` slot's value in milliseconds, or `undefined` when it holds
 * neither form a reader is handed: the duration instance a decoded slot holds, or
 * an integer number of milliseconds — what a policy assembled in code carries, and
 * what an older runtime that typed the slot as an integer delivers. A fraction of a
 * millisecond is kept. Text is never read here: it is decoded where it arrives.
 */
export function durationMs(value: unknown): number | undefined {
  if (isCelDuration(value)) {
    const nanos = durationNanos(value);
    return Number(nanos / NANOS_PER_MILLISECOND) + Number(nanos % NANOS_PER_MILLISECOND) / 1e6;
  }
  return Number.isSafeInteger(value) ? (value as number) : undefined;
}
