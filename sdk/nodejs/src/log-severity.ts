/**
 * The OpenTelemetry `SeverityNumber` scale (1–24, stable), which Telo adopts
 * verbatim — see `kernel/specs/logging.md` §5.
 *
 * Higher is more severe. All comparison, filtering, and threshold logic uses the
 * number; severity *text* is presentation only and MUST NOT be compared. The
 * full 24-value range stays valid on the wire so records bridged from a
 * third-party logger survive a round-trip with their original spelling intact.
 */

/** An OTel SeverityNumber. `0` (UNSPECIFIED) is never emitted by a Telo runtime. */
export type SeverityNumber = number;

/** The six levels Telo names. Each is the floor of its four-value OTel range. */
export const SEVERITY = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

export type LevelName = keyof typeof SEVERITY;

export const LEVEL_NAMES: readonly LevelName[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** The severity at or above which a record describes an error (§5.1). This is
 *  the portable error predicate; runtimes expose it rather than re-deriving it. */
export const ERROR_SEVERITY_FLOOR = 17;

const FLOORS: readonly number[] = [1, 5, 9, 13, 17, 21];

const TEXT_BY_FLOOR: Readonly<Record<number, string>> = {
  1: "TRACE",
  5: "DEBUG",
  9: "INFO",
  13: "WARN",
  17: "ERROR",
  21: "FATAL",
};

/**
 * The range floor for a severity number — the canonical level a value maps onto.
 * Out-of-range values clamp into 1–24 rather than producing `0`, which §5.1
 * forbids emitting.
 */
export function severityFloor(severity: SeverityNumber): number {
  const clamped = severity < 1 ? 1 : severity > 24 ? 24 : Math.trunc(severity);
  let floor = FLOORS[0]!;
  for (const candidate of FLOORS) {
    if (candidate <= clamped) floor = candidate;
    else break;
  }
  return floor;
}

/** Canonical short name (`TRACE`…`FATAL`) for a severity number. */
export function severityText(severity: SeverityNumber): string {
  return TEXT_BY_FLOOR[severityFloor(severity)]!;
}

/** `true` when the record describes an error (§5.1). */
export function isErrorSeverity(severity: SeverityNumber): boolean {
  return severity >= ERROR_SEVERITY_FLOOR;
}

/** Resolve a manifest `level:` name to its severity number. */
export function severityForLevel(level: LevelName): number {
  return SEVERITY[level];
}

/**
 * Map a level name of unknown provenance onto the scale. A name Telo does not
 * recognize yields `undefined` so the caller can preserve the original spelling
 * in `severity_text` while landing the number on a range floor (§5.1).
 */
export function parseLevelName(name: string): number | undefined {
  const key = name.trim().toLowerCase();
  // Own-property check, not `in`: `in` also matches inherited members, so
  // `parseLevelName("toString")` would otherwise return a Function and defeat
  // the `?? fallback` at every call site. Written as `hasOwnProperty.call`
  // rather than `Object.hasOwn` because this module is consumed from source by
  // the browser-targeted editor, whose tsconfig targets below ES2022.
  return Object.prototype.hasOwnProperty.call(SEVERITY, key)
    ? SEVERITY[key as LevelName]
    : undefined;
}

/**
 * Go's `log/slog` documents that subtracting 9 from an OTel severity converts it
 * to the slog range — an exact, officially sanctioned relation, so a Go runtime
 * uses arithmetic rather than a table (§5.2). Exposed here so the conformance
 * vectors can assert the relation from the Node side too.
 */
export const SLOG_OFFSET = 9;

/**
 * pino's scale is 10× and offset, with no arithmetic relation to OTel, so §5.2
 * requires a table. Used by the Fastify logger replacement (§13.3).
 */
const PINO_BY_SEVERITY: Readonly<Record<number, number>> = {
  1: 10,
  5: 20,
  9: 30,
  13: 40,
  17: 50,
  21: 60,
};

const SEVERITY_BY_PINO: Readonly<Record<number, number>> = {
  10: 1,
  20: 5,
  30: 9,
  40: 13,
  50: 17,
  60: 21,
};

export function pinoLevelForSeverity(severity: SeverityNumber): number {
  return PINO_BY_SEVERITY[severityFloor(severity)]!;
}

/** `undefined` for a pino level Telo does not name, so the caller preserves the
 *  source spelling and falls back to the nearest floor. */
export function severityForPinoLevel(level: number): number | undefined {
  return SEVERITY_BY_PINO[level];
}
