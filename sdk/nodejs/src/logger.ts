import type { AnyValue, LogAttributes } from "./log-record.js";
import type { SeverityNumber } from "./log-severity.js";

/**
 * The logger surface every Telo runtime exposes — `kernel/specs/logging.md` §8.
 *
 * Reached ambiently as `ctx.log`. The logger is ambient rather than a resource
 * because it must work before any resource initializes; its *sinks* are
 * resources, which is what keeps the destination set open to the ecosystem.
 */

/**
 * A value resolved only on the emit path (§8.2) — slog's `LogValuer`, zap's
 * `ObjectMarshaler`, `tracing`'s `Value`. A deferred value attached to a
 * suppressed record is never resolved, so an expensive rendering costs nothing
 * below the threshold. This is RECOMMENDED sugar and does **not** substitute for
 * {@link Logger.enabled}, which is the only mechanism that avoids evaluating a
 * call's *arguments*.
 */
export interface LogValuer {
  toLogValue(): AnyValue;
}

export type LogAttributeInput = AnyValue | LogValuer;
export type LogAttributesInput = Record<string, LogAttributeInput>;

/** Per-record extras that are top-level record fields rather than attributes.
 *  Kept out of the attribute map so they cannot collide with a reserved key. */
export interface LogOptions {
  /** Any thrown value. Normalized to the record's `error` (§4.2), with the
   *  `cause` chain bounded per §6.3. */
  error?: unknown;
  /** Identifies a class of event; max 256 chars. Bridges to the event bus. */
  eventName?: string;
  /** When the event occurred, if earlier than the moment `log()` was called —
   *  set by a bridge, which also stamps `observedTimestamp` (§13.3). */
  timestamp?: bigint;
  /** The original source spelling of the level, preserved when bridging a level
   *  Telo does not name (§5.1). Defaults to the canonical short name. */
  severityText?: string;
}

export interface Logger {
  /**
   * Whether a record at this severity would reach any sink. The load-bearing
   * performance primitive: guard an expensive call with it so the *arguments*
   * are never evaluated.
   *
   * Never blocks, never throws. The result is **not static** — it changes when
   * configuration changes or a sink attaches or detaches (§12.4), so callers
   * re-check per emission rather than caching a boolean.
   */
  enabled(severity: SeverityNumber): boolean;

  /**
   * Emit a record. Never throws, under any condition, including sink failure —
   * a sink failure is reported on the fallback diagnostic stream and counted,
   * never propagated and never swallowed (§8.4).
   */
  log(
    severity: SeverityNumber,
    message: string,
    attributes?: LogAttributesInput,
    options?: LogOptions,
  ): void;

  /**
   * A child logger whose bound attributes are merged into every record it emits.
   * Record attributes override bound attributes. Binding is O(1) amortized: the
   * merge happens once here, never per record.
   */
  with(attributes: LogAttributesInput): Logger;

  /** Drain every attached sink. Bounded by the caller; see §10.5. */
  flush(): Promise<void>;

  trace(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
  debug(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
  info(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
  warn(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
  error(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
  /**
   * Emits at severity 21. Severity never implies control flow (§5, D5): `fatal`
   * does **not** terminate the process, exit, or panic — it triggers an
   * immediate flush, synchronous on every sink that supports it and best-effort
   * on the rest (§10.5).
   */
  fatal(message: string, attributes?: LogAttributesInput, options?: LogOptions): void;
}

/** Resolve a {@link LogValuer} if the value is one, else pass it through. */
export function isLogValuer(value: unknown): value is LogValuer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as LogValuer).toLogValue === "function"
  );
}

/** A logger that discards everything. Used where a logger is structurally
 *  required before one is available, and by tests that assert silence. */
export const NOOP_LOGGER: Logger = {
  enabled: () => false,
  log: () => {},
  with: () => NOOP_LOGGER,
  flush: async () => {},
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
};

/** The bound-attribute merge of {@link Logger.with}, exposed so a runtime's
 *  child-logger implementation and its conformance vectors share one definition
 *  of "record attributes win". */
export function mergeBoundAttributes(
  bound: LogAttributes | undefined,
  record: LogAttributes | undefined,
): LogAttributes | undefined {
  if (!bound) return record;
  if (!record) return bound;
  return { ...bound, ...record };
}
