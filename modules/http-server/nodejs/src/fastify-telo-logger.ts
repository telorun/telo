import {
  pinoLevelForSeverity,
  SEVERITY,
  severityForPinoLevel,
  severityText,
  type LogAttributesInput,
  type Logger,
} from "@telorun/sdk";

/**
 * A Telo-backed logger injected into Fastify — `kernel/specs/logging.md` §13.3.
 *
 * Replacement, not bridging. Fastify accepts an injected logger satisfying a
 * small interface, so its records are Telo records **from the moment they are
 * created**: no format to translate, no second pipeline, and no possibility of
 * the two diverging. Bridging — intercepting the stream Pino writes and
 * re-parsing it — is strictly worse and is reserved for libraries that offer no
 * injection point.
 *
 * This also removes the duplication where a mid-stream failure was both logged
 * to Pino and separately re-emitted as an event for debug tooling: with the
 * adapter in place, one record reaches every sink, including the debug wire.
 */

/** The subset of Pino's interface Fastify actually calls. */
export interface FastifyLogger {
  level: string;
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  silent(...args: unknown[]): void;
  // Fastify calls this as `child(bindings, options)` — the second Pino-options
  // argument is accepted and ignored (the manifest is the only config source).
  child(bindings: Record<string, unknown>, options?: unknown): FastifyLogger;
}

export function createFastifyTeloLogger(log: Logger): FastifyLogger {
  const emit = (severity: number, args: unknown[]): void => {
    if (!log.enabled(severity)) return;
    const { message, attributes, error } = splitPinoArgs(args);
    log.log(severity, message, attributes, error === undefined ? undefined : { error });
  };

  return {
    // Fastify reads `level` to decide whether to build a request-log object at
    // all. Reporting the most verbose level Telo would accept keeps that gate
    // aligned with the pipeline's own, which is the real threshold.
    get level(): string {
      for (const severity of [SEVERITY.trace, SEVERITY.debug, SEVERITY.info, SEVERITY.warn]) {
        if (log.enabled(severity)) return severityText(severity).toLowerCase();
      }
      return log.enabled(SEVERITY.error) ? "error" : "silent";
    },
    set level(_value: string) {
      // Fastify may try to set a level; the manifest is the only configuration
      // source (D6), so this is deliberately inert.
    },
    fatal: (...args) => emit(SEVERITY.fatal, args),
    error: (...args) => emit(SEVERITY.error, args),
    warn: (...args) => emit(SEVERITY.warn, args),
    info: (...args) => emit(SEVERITY.info, args),
    debug: (...args) => emit(SEVERITY.debug, args),
    trace: (...args) => emit(SEVERITY.trace, args),
    silent: () => {},
    // Fastify's per-request child logger maps onto §8.3's bound attributes.
    child: (bindings) => createFastifyTeloLogger(log.with(normalizeBindings(bindings))),
  };
}

/**
 * Pino's call shapes are `(msg)`, `(obj)`, `(obj, msg)`, and `(msg, ...interp)`.
 * Telo requires a string message with structured data in attributes, so the
 * object half becomes attributes and the string half the message.
 */
function splitPinoArgs(args: unknown[]): {
  message: string;
  attributes: LogAttributesInput | undefined;
  error: unknown;
} {
  const [first, second] = args;

  if (typeof first === "string") {
    return { message: interpolate(first, args.slice(1)), attributes: undefined, error: undefined };
  }

  if (first && typeof first === "object") {
    const bag = { ...(first as Record<string, unknown>) };
    // Pino puts the error under `err`; Telo has a dedicated top-level field for
    // it, so it is lifted out of the attributes rather than serialized twice.
    const error = bag["err"];
    delete bag["err"];
    const message = typeof second === "string" ? interpolate(second, args.slice(2)) : "";
    return { message, attributes: normalizeBindings(bag), error };
  }

  return { message: first === undefined ? "" : String(first), attributes: undefined, error: undefined };
}

/** Pino's printf-style interpolation, limited to the specifiers it documents. */
function interpolate(template: string, values: unknown[]): string {
  if (values.length === 0) return template;
  let index = 0;
  return template.replace(/%[sdjoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= values.length) return token;
    const value = values[index++];
    return typeof value === "string" ? value : safeStringify(value);
  });
}

function normalizeBindings(bindings: Record<string, unknown>): LogAttributesInput {
  const out: LogAttributesInput = {};
  for (const [key, value] of Object.entries(bindings)) {
    // Fastify binds `req`/`res` objects that are not attribute values; their
    // useful fields are already carried as OTel semantic conventions below.
    if (key === "req" || key === "res") {
      Object.assign(out, httpAttributes(value));
      continue;
    }
    out[key] = value as never;
  }
  return out;
}

/** §6.2: where a standard OTel semantic convention exists, use it rather than a
 *  Telo-specific spelling. */
function httpAttributes(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof source["method"] === "string") out["http.request.method"] = source["method"];
  if (typeof source["url"] === "string") out["url.path"] = source["url"];
  if (typeof source["statusCode"] === "number") {
    out["http.response.status_code"] = source["statusCode"];
  }
  // Headers are NOT captured: §14.4 requires explicit configuration naming the
  // headers, matching OTel's Opt-In requirement level.
  return out;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export { pinoLevelForSeverity, severityForPinoLevel };
