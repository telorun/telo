const INVOKE_ERROR = Symbol.for("telo.InvokeError");

/**
 * Structured, catchable error for invocables and runnables. Route handlers and
 * Run.Sequence try/catch match on `code`; downstream renderers consume `data`.
 *
 * Use `isInvokeError` for recognition, not `instanceof` — dual-realm safe
 * across pnpm hoist splits, registry modules, and future sandbox isolation.
 */
export class InvokeError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "InvokeError";
    this.code = code;
    this.data = data;
    // Set via defineProperty (not a class field initializer) so the marker is
    // always present regardless of TS/runtime class-field semantics
    // (useDefineForClassFields, Error-subclass quirks, etc.) and stays
    // non-enumerable so JSON serialisation / CEL property access don't trip
    // over it.
    Object.defineProperty(this, INVOKE_ERROR, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

export function isInvokeError(err: unknown): err is InvokeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[INVOKE_ERROR] === true
  );
}
