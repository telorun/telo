/**
 * Duration parsing — the shared time helper for controllers. Telo writes human
 * durations (`250ms`, `2s`, `1.5m`, `1h`) in manifests for timers, TTLs,
 * windows, connect timeouts, backoff, and so on; this is the single place that
 * turns one into a millisecond count. Consumers own their own error UX:
 * `tryParseDurationMs` returns `null` on a bad string so a caller can throw its
 * own typed error (e.g. an `InvokeError` for invoke-time input); `parseDurationMs`
 * throws a coded `RuntimeError` and treats `undefined` as a default (for optional
 * fields), so a bad duration in a manifest surfaces as a structured config error.
 */
import { RuntimeError } from "./types.js";

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/;
const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** Parse a duration string to milliseconds, or `null` if it is not a valid
 *  duration. Lets the caller own the error message and error type. */
export function tryParseDurationMs(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Parse a duration string (`300s`, `5m`, `1h`, `50ms`) to milliseconds. An
 *  `undefined` value yields `fallback` (default `0`) for optional fields; an
 *  invalid string throws a plain `Error`. */
export function parseDurationMs(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const ms = tryParseDurationMs(value);
  if (ms === null) {
    throw new RuntimeError(
      "ERR_INVALID_VALUE",
      `Invalid duration ${JSON.stringify(value)}; use a number with a unit, e.g. "250ms", "2s", "1.5m", "1h".`,
    );
  }
  return ms;
}
